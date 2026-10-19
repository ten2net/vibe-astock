param([switch]$SkipDoctor)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Assert-NativeSuccess([string]$Step) {
  if ($LASTEXITCODE -ne 0) { throw "$Step 失败（退出码 $LASTEXITCODE）" }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "未找到 Node.js。请先安装 Node.js 22 或更高版本。" }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "未找到 npm。请重新安装 Node.js。" }
& node (Join-Path $root "scripts\check-node.mjs")
Assert-NativeSuccess "Node 运行时预检"

$venvPython = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
  if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3.12 -c "import sys" 2>$null
    if ($LASTEXITCODE -eq 0) { & py -3.12 -m venv .venv; Assert-NativeSuccess "创建 Python 3.12 虚拟环境" }
    else { & py -3 -m venv .venv; Assert-NativeSuccess "创建 Python 3 虚拟环境" }
  }
  elseif (Get-Command python -ErrorAction SilentlyContinue) { & python -m venv .venv; Assert-NativeSuccess "创建 Python 虚拟环境" }
  else { throw "未找到 Python。请先安装 Python 3.11 或更高版本（推荐 3.12）。" }
}

& $venvPython -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)"
if ($LASTEXITCODE -ne 0) { throw "Vibe AStock 需要 Python 3.11 或更高版本（推荐 3.12）。请删除 .venv 后重新运行安装。" }

& $venvPython -m pip install --upgrade pip
Assert-NativeSuccess "升级 pip"
& $venvPython -m pip install -r ".agents\skills\data-access\scripts\requirements.txt"
Assert-NativeSuccess "安装 Python 依赖"
& npm ci --prefix orchestrator --no-audit --no-fund
Assert-NativeSuccess "安装 orchestrator 依赖"
& npm ci --prefix desktop --no-audit --no-fund
Assert-NativeSuccess "安装 desktop 依赖"
& node (Join-Path $root "orchestrator\src\init.ts") --python $venvPython
Assert-NativeSuccess "初始化产品目录"
if (-not $SkipDoctor) {
  & node (Join-Path $root "orchestrator\src\doctor.ts") --python $venvPython
  $doctorExit = $LASTEXITCODE
  if ($doctorExit -notin @(0, 2)) { throw "运行产品体检失败（退出码 $doctorExit）" }
  if ($doctorExit -eq 2) { Write-Warning "产品体检有待处理警告；安装已完成，请按上方提示处理。" }
}

Write-Host "Windows 初始化完成。运行 scripts\start.cmd 打开 Vibe AStock。" -ForegroundColor Green
