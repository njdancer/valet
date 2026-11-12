# Local portfolio (example)

An example of a local-data adapter (docs/sandbox.md). It reads `~/Documents/Valet/portfolio.csv`,
one `symbol,quantity` line per holding, and values each one at Yahoo Finance's latest price.

Its manifest declares exactly one sandbox exception: read access to that one file. Nothing else on
the Mac is reachable from its code, and the approval shows the exception and its purpose.

Install it in a development build with "Install from a folder", pointing at this folder.
