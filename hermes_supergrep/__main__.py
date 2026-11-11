# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright The Infino Authors
"""`python -m hermes_supergrep status|index|mcp`: the `hermes supergrep`
command outside Hermes, for a shell or a test."""
import sys

from .cli import main

sys.exit(main())
