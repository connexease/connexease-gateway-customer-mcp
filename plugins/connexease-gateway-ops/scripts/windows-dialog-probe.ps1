Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$productionHelper = Join-Path $PSScriptRoot 'windows-native.ps1'
$helper = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N') + '-gateway-ui-probe.ps1')
$source = [IO.File]::ReadAllText($productionHelper)
$silentCatch = "Write-Result 'error' `$null"
if (-not $source.Contains($silentCatch)) { throw 'Could not prepare a diagnostic copy of the Windows helper' }
$source = $source.Replace($silentCatch,
  '[Console]::Error.WriteLine($_.Exception.ToString())' + [Environment]::NewLine + '  ' + $silentCatch)
$source = $source.Replace('$payload = if ([string]::IsNullOrWhiteSpace($raw))',
  '[Console]::Error.WriteLine("Synthetic input: [" + $raw + "]")' + [Environment]::NewLine +
  '  $payload = if ([string]::IsNullOrWhiteSpace($raw))')
[IO.File]::WriteAllText($helper, $source)
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Find-Dialog([System.Diagnostics.Process]$DialogProcess, [string]$Title) {
  $processCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $DialogProcess.Id)
  $titleCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty, $Title)
  $condition = [System.Windows.Automation.AndCondition]::new(@($processCondition, $titleCondition))
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    if ($DialogProcess.HasExited) {
      $stdout = $DialogProcess.StandardOutput.ReadToEnd().Trim()
      $stderr = $DialogProcess.StandardError.ReadToEnd().Trim()
      throw "Native helper exited before showing a dialog (exit $($DialogProcess.ExitCode)); stdout: $stdout; stderr: $stderr"
    }
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
      [System.Windows.Automation.TreeScope]::Children, $condition)
    if ($windows.Count -gt 0) { return $windows.Item(0) }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'The native dialog did not appear on the Windows desktop within 10 seconds'
}

function Find-Control($Window, $Type, [string]$Name = $null) {
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    $children = $Window.FindAll([System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($child in $children) {
      if ($child.Current.ControlType.ProgrammaticName -eq $Type.ProgrammaticName -and
        ([string]::IsNullOrEmpty($Name) -or $child.Current.Name -eq $Name)) { return $child }
    }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Native dialog control is missing: $Name"
}

function Click-Button($Window, [string]$Name) {
  $button = Find-Control $Window ([System.Windows.Automation.ControlType]::Button) $Name
  $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $pattern.Invoke()
}

function Exercise-Dialog([string]$Action, $Payload, [string]$ExpectedStatus, [string]$ExpectedValue) {
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $powershell
  $start.Arguments = "-NoLogo -NoProfile -NonInteractive -Sta -ExecutionPolicy Bypass -File `"$helper`" -Action $Action"
  $start.UseShellExecute = $false
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.CreateNoWindow = $true
  $taskProcess = New-Object System.Diagnostics.Process
  $taskProcess.StartInfo = $start
  try {
    if (-not $taskProcess.Start()) { throw 'Could not start the Windows dialog helper' }
    $json = ConvertTo-Json -InputObject $Payload -Compress -Depth 8
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($json)
    $taskProcess.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $taskProcess.StandardInput.BaseStream.Close()

    $title = if ($Action -eq 'prompt') { 'Connexease Gateway' } else { 'Confirm Connexease Gateway action' }
    $window = Find-Dialog $taskProcess $title
    if ($Action -eq 'prompt') {
      $edit = Find-Control $window ([System.Windows.Automation.ControlType]::Edit)
      if ([bool]$edit.Current.IsPassword -ne [bool]$Payload.hidden) {
        throw 'Password masking state does not match the requested dialog'
      }
      if ($Payload.hidden) { Click-Button $window 'Cancel' }
      else {
        $valuePattern = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $valuePattern.SetValue('ui-smoke@example.test')
        Click-Button $window 'Continue'
      }
    } else {
      $review = Find-Control $window ([System.Windows.Automation.ControlType]::Edit)
      $valuePattern = $review.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      if (-not $valuePattern.Current.IsReadOnly) { throw 'Confirmation review is editable' }
      if ($valuePattern.Current.Value -ne [string]$Payload.value) { throw 'Confirmation review does not match the exact value' }
      Click-Button $window $ExpectedValue
    }

    if (-not $taskProcess.WaitForExit(10000)) { throw 'Native dialog did not close after the button was clicked' }
    $output = $taskProcess.StandardOutput.ReadToEnd().Trim()
    if ($taskProcess.ExitCode -ne 0) {
      throw "Native dialog helper failed: $($taskProcess.StandardError.ReadToEnd())"
    }
    $result = ConvertFrom-Json -InputObject $output
    if ($result.status -ne $ExpectedStatus) { throw "Unexpected dialog status: $($result.status)" }
    if ($Action -eq 'prompt' -and -not $Payload.hidden -and $result.value -ne 'ui-smoke@example.test') {
      throw 'The email dialog did not return the value entered through UI Automation'
    }
  } finally {
    if (-not $taskProcess.HasExited) { $taskProcess.Kill() }
    $taskProcess.Dispose()
  }
}

try {
  Exercise-Dialog 'prompt' @{ label = 'Connexease Gateway email address'; hidden = $false } 'ok' 'Continue'
  Exercise-Dialog 'prompt' @{ label = 'Connexease Gateway password'; hidden = $true } 'cancelled' 'Cancel'
  Exercise-Dialog 'confirm' @{ prompt = 'Apply one synthetic test action?'; value = 'synthetic-preview-only'; approveLabel = 'Apply' } 'ok' 'Apply'
  Exercise-Dialog 'confirm' @{ prompt = 'Cancel one synthetic test action?'; value = 'synthetic-preview-only'; approveLabel = 'Apply' } 'cancelled' 'Cancel'
  Write-Output 'Native Windows email, masked password, confirmation and cancellation dialogs passed UI Automation.'
} finally {
  Remove-Item -LiteralPath $helper -ErrorAction SilentlyContinue
}
