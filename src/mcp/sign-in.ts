// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Sign-in for the server over HTTP, the resource server's half of it as
// the MCP clients expect (OAuth 2.1): every call carries a bearer token,
// which is an Infino account's key; a call with none, or with one the
// platform refuses, is answered 401 naming the resource metadata - the
// document that says which authorization server signs people in - and
// that is what makes a client start the sign-in. The session a call opens
// runs on the account the token is the key of.
//
// Nothing of the sign-in itself is here: no authorize page, no token
// endpoint, no account creation. Those are the authorization server's,
// which belongs to the deployment - the demo's hands each connection a
// trial account - and this server only knows where its metadata is.

import type { IncomingMessage } from "node:http";
import { HostedError } from "../core/hosted.js";
import { listDatabases } from "../core/account-api.js";

/** A key as the platform mints one, checked before any call is spent on a
 * token that could never be one. */
const KEY_SHAPE = /^inf_[0-9a-f]+_[0-9a-f]+$/;

export interface SignInSettings {
  /** The URL of the OAuth protected-resource metadata (RFC 9728) a call
   * with no token is pointed at: the document naming the authorization
   * server that signs people in to this endpoint. */
  resourceMetadataUrl: string;
  /** The platform a presented key is checked against: the `--db` one. */
  platformBaseUrl: string;
  /** Platform calls; injected for tests. */
  fetch?: typeof fetch;
}

/** What a presented token is: a key the platform accepts; one it refuses
 * (the client signs the person in again); or unknowable, the platform
 * having not answered - which is not the token's fault. */
export type TokenVerdict = "ok" | "refused" | "unavailable";

export class SignIn {
  private readonly settings: SignInSettings;

  constructor(settings: SignInSettings) {
    this.settings = settings;
  }

  /** Where the sign-in is, for the log line. */
  get resourceMetadataUrl(): string {
    return this.settings.resourceMetadataUrl;
  }

  /** The `WWW-Authenticate` value a call with no (or a refused) token gets:
   * where the resource metadata is. A client reads the authorization
   * server off that document. */
  challenge(): string {
    return `Bearer resource_metadata="${this.settings.resourceMetadataUrl}"`;
  }

  /** The bearer token a request carries, or null. */
  bearer(req: IncomingMessage): string | null {
    const header = req.headers.authorization;
    if (typeof header !== "string") return null;
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    return match ? match[1] : null;
  }

  /** Whether `token` is a key the platform accepts: the shape first, so a
   * token that could never be a key costs the platform nothing, then the
   * lightest authenticated call there is. A 401 or 402 is `refused`. */
  async checkToken(token: string): Promise<TokenVerdict> {
    if (!KEY_SHAPE.test(token)) return "refused";
    try {
      await listDatabases({ baseUrl: this.settings.platformBaseUrl, apiKey: token }, { fetch: this.settings.fetch ?? fetch });
      return "ok";
    } catch (err) {
      if (err instanceof HostedError && (err.unauthenticated || err.paymentRequired)) return "refused";
      return "unavailable";
    }
  }
}
