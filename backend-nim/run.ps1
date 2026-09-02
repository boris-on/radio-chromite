$nimHome = Get-ChildItem -LiteralPath 'C:\nim' -Directory -Filter 'nim-*' |
  Sort-Object Name -Descending |
  Select-Object -First 1

if (-not $nimHome) {
  throw 'Nim installation was not found under C:\nim.'
}

$nimBin = Join-Path $nimHome.FullName 'bin'
$env:PATH = $nimBin + ';C:\msys64\mingw64\bin;' + $env:PATH

$backendRoot = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\'
$runningBackends = Get-CimInstance Win32_Process -Filter "Name = 'radio_chromite_backend.exe'" |
  Where-Object {
    $_.ExecutablePath -and
    [System.IO.Path]::GetFullPath($_.ExecutablePath).StartsWith(
      $backendRoot,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  }

foreach ($backend in $runningBackends) {
  Write-Host "Stopping existing RADIO CHROMITE backend (PID $($backend.ProcessId))..."
  Stop-Process -Id $backend.ProcessId -Force -ErrorAction Stop
  Wait-Process -Id $backend.ProcessId -ErrorAction SilentlyContinue
}

& (Join-Path $nimBin 'nimble.exe') run
exit $LASTEXITCODE
