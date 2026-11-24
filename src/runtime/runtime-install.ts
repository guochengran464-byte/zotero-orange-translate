// Upstream's uv installation route, pinned to the supplied translator release.
// No API credentials or documents are used while preparing the environment.
const BITSTRING_REQUIREMENT = 'bitstring<5'; // BabelDOC 0.6.2 imports BitStream.

export const RUNTIME_INSTALL_SCRIPT = String.raw`param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$Root = [IO.Path]::GetFullPath($Root)
$log = Join-Path $Root 'installer.log'
$code = 'INSTALL_FAILED'
function Stage([string]$name) { [Console]::WriteLine('{"stage":"' + $name + '"}') }
function RunUv([string[]]$Arguments) {
  $ErrorActionPreference = 'Continue'
  & $uv @Arguments >> $log 2>&1
  if ($LASTEXITCODE -ne 0) { throw $code }
}
try {
  if (!(Test-Path -LiteralPath (Join-Path $Root '.orange-translate-runtime.json'))) { throw 'INSTALL_DIR_UNOWNED' }
  $readyFile = Join-Path $Root 'ready.json'
  if (Test-Path -LiteralPath $readyFile) { Remove-Item -LiteralPath $readyFile }
  Set-Location -LiteralPath $Root
  foreach ($name in @('downloads','tools','temp','cache','home','local-app-data','roaming-app-data','runtime')) {
    [IO.Directory]::CreateDirectory((Join-Path $Root $name)) | Out-Null
  }
  $env:USERPROFILE = $Root; $env:HOME = $Root
  $env:LOCALAPPDATA = Join-Path $Root 'local-app-data'; $env:APPDATA = Join-Path $Root 'roaming-app-data'
  $env:TEMP = Join-Path $Root 'temp'; $env:TMP = $env:TEMP
  $env:XDG_CACHE_HOME = Join-Path $Root '.cache'; $env:XDG_CONFIG_HOME = Join-Path $Root 'config'
  $env:UV_CACHE_DIR = Join-Path $Root 'cache\uv'; $env:PIP_CACHE_DIR = Join-Path $Root 'cache\pip'
  $env:UV_PYTHON_INSTALL_DIR = Join-Path $Root 'runtime\managed-python'
  $env:UV_PYTHON_BIN_DIR = Join-Path $Root 'tools'; $env:UV_TOOL_BIN_DIR = Join-Path $Root 'tools'
  $env:UV_NO_CONFIG = '1'; $env:PYTHONDONTWRITEBYTECODE = '1'
  $env:PYTHONPATH = ''; $env:PYTHONHOME = ''; $env:VIRTUAL_ENV = ''
  $env:HF_HOME = Join-Path $Root 'cache\huggingface'; $env:HF_ENDPOINT = 'https://hf-mirror.com'
  $env:TIKTOKEN_CACHE_DIR = Join-Path $Root '.cache\babeldoc\tiktoken'
  Stage 'DOWNLOAD_UV'; $code = 'DOWNLOAD_FAILED'
  $archive = Join-Path $Root 'downloads\uv-0.12.23.zip'
  $expected = '75d05de6762778c31ee183398de7dd15093fad0ed90b1f236d8205ea5ec00c90'
  if (!(Test-Path -LiteralPath $archive) -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLower() -ne $expected) {
    $part = $archive + '.part'
    $url = 'https://github.com/astral-sh/uv/releases/download/0.12.23/uv-x86_64-pc-windows-msvc.zip'
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (Test-Path -LiteralPath $curl) {
      $ErrorActionPreference = 'Continue'
      & $curl '-fLsS' '--retry' '3' '--connect-timeout' '30' '--max-time' '1200' '-o' $part $url >> $log 2>&1
      $ok = $LASTEXITCODE -eq 0
      $ErrorActionPreference = 'Stop'
    } else { $ok = $false }
    if (!$ok) {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -UseBasicParsing -Uri 'https://api.github.com/repos/astral-sh/uv/releases/assets/608232617' -Headers @{Accept='application/octet-stream'} -OutFile $part -TimeoutSec 1200
    }
    $code = 'DOWNLOAD_HASH_MISMATCH'
    if ((Get-FileHash -LiteralPath $part -Algorithm SHA256).Hash.ToLower() -ne $expected) { throw $code }
    Move-Item -LiteralPath $part -Destination $archive -Force
  }
  $code = 'INSTALL_FAILED'
  Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $Root 'tools') -Force
  $uv = Join-Path $Root 'tools\uv.exe'
  if (!(Test-Path -LiteralPath $uv)) { throw $code }
  Stage 'INSTALL_PYTHON'; $code = 'PYTHON_INSTALL_FAILED'
  RunUv @('python','install','3.12','--no-bin','--no-config')
  $venv = Join-Path $Root 'runtime\python'
  $python = Join-Path $venv 'Scripts\python.exe'
  if (!(Test-Path -LiteralPath $python)) { RunUv @('venv','--python','3.12','--managed-python','--no-config',$venv) }
  Stage 'INSTALL_ENGINE'; $code = 'ENGINE_INSTALL_FAILED'
  $libs = Join-Path $Root 'runtime\libs'
  RunUv @('pip','install','--python',$python,'--target',$libs,'--no-config','--only-binary',':all:','pdf2zh-next==2.9.0','babeldoc==0.6.2','${BITSTRING_REQUIREMENT}')
  Stage 'DOWNLOAD_ASSETS'; $code = 'ASSETS_INSTALL_FAILED'
  $env:PYTHONPATH = $libs
  $ErrorActionPreference = 'Continue'
  & $python '-c' 'import pdf2zh_next.main; from babeldoc.assets.assets import warmup; warmup()' >> $log 2>&1
  $ok = $LASTEXITCODE -eq 0
  $ErrorActionPreference = 'Stop'
  if (!$ok) { throw $code }
  [IO.File]::WriteAllText((Join-Path $Root 'ready.json'), '{"schemaVersion":1,"engine":"pdf2zh-next","version":"2.9.0","babeldoc":"0.6.2"}')
  Stage 'READY'; exit 0
} catch {
  Stage $code; exit 1
}
`;

export const MAC_RUNTIME_INSTALL_SCRIPT = String.raw`set -eu
root=$1
log=$root/installer.log
code=INSTALL_FAILED
stage() { printf '{"stage":"%s"}\n' "$1"; }
trap 'status=$?; if [ "$status" -ne 0 ]; then stage "$code"; fi' EXIT

[ -f "$root/.orange-translate-runtime.json" ]
rm -f "$root/ready.json"
mkdir -p "$root/downloads" "$root/tools" "$root/temp" "$root/cache" "$root/runtime"
export HOME="$root" TMPDIR="$root/temp" XDG_CACHE_HOME="$root/.cache" XDG_CONFIG_HOME="$root/config"
export UV_CACHE_DIR="$root/cache/uv" UV_PYTHON_INSTALL_DIR="$root/runtime/managed-python" UV_NO_CONFIG=1
export HF_HOME="$root/cache/huggingface" PYTHONDONTWRITEBYTECODE=1 PYTHONUTF8=1
unset PYTHONHOME PYTHONPATH VIRTUAL_ENV

stage DOWNLOAD_UV
code=DOWNLOAD_FAILED
archive=$root/downloads/uv-0.12.23-aarch64-apple-darwin.tar.gz
expected=50487ae565ccd96e499056b4674d438f4c53170202617b4c759defe0c6a1b544
verify() {
  digest=$(/usr/bin/shasum -a 256 < "$1" 2>> "$log") && [ "$digest" = "$expected  -" ]
}
if [ ! -f "$archive" ] || ! verify "$archive"; then
  /usr/bin/curl -fLsS --retry 3 --connect-timeout 30 --max-time 1200 -o "$archive.part" \
    https://github.com/astral-sh/uv/releases/download/0.12.23/uv-aarch64-apple-darwin.tar.gz >> "$log" 2>&1
  code=DOWNLOAD_HASH_MISMATCH
  verify "$archive.part"
  mv -f "$archive.part" "$archive"
fi
code=INSTALL_FAILED
uv=$root/tools/uv
/usr/bin/tar -xzOf "$archive" uv-aarch64-apple-darwin/uv > "$uv.part" 2>> "$log"
chmod 755 "$uv.part"
mv -f "$uv.part" "$uv"

stage INSTALL_PYTHON
code=PYTHON_INSTALL_FAILED
"$uv" python install 3.12 --no-bin >> "$log" 2>&1
venv=$root/runtime/python
python=$venv/bin/python
if [ ! -x "$python" ]; then
  "$uv" venv --python 3.12 --managed-python "$venv" >> "$log" 2>&1
fi

stage INSTALL_ENGINE
code=ENGINE_INSTALL_FAILED
libs=$root/runtime/libs
"$uv" pip install --python "$python" --target "$libs" --only-binary :all: \
  pdf2zh-next==2.9.0 babeldoc==0.6.2 '${BITSTRING_REQUIREMENT}' >> "$log" 2>&1

stage DOWNLOAD_ASSETS
code=ASSETS_INSTALL_FAILED
PYTHONPATH="$libs" "$python" -c 'import pdf2zh_next.main; from babeldoc.assets.assets import warmup; warmup()' >> "$log" 2>&1
printf '%s\n' '{"schemaVersion":1,"engine":"pdf2zh-next","version":"2.9.0","babeldoc":"0.6.2"}' > "$root/ready.json.part"
mv -f "$root/ready.json.part" "$root/ready.json"
stage READY
`;
