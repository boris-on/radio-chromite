$backendRoot = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\'
$projectRoot = Split-Path -Parent $PSScriptRoot
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

Push-Location $projectRoot
try {
  & npm run backend
  $backendExitCode = $LASTEXITCODE
} finally {
  Pop-Location
}
exit $backendExitCode
