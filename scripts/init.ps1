$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
# Node 运行时预检:版本不够或构建未启用 TypeScript 支持时给出指引,而不是 ERR_UNKNOWN_FILE_EXTENSION(#38)
& node (Join-Path $root "scripts\check-node.mjs")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node (Join-Path $root "orchestrator\src\init.ts") @args
exit $LASTEXITCODE
