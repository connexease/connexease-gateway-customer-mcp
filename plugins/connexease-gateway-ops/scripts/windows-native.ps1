param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('prompt', 'confirm', 'open-file', 'save-file', 'token-read', 'token-write', 'token-delete')]
  [string]$Action
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-Result([string]$Status, $Value) {
  [Console]::Out.WriteLine((@{ status = $Status; value = $Value } | ConvertTo-Json -Compress -Depth 8))
}

function New-Dialog([string]$Title, [int]$Height) {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = $Title
  $form.Width = 640
  $form.Height = $Height
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.ShowInTaskbar = $true
  $form.TopMost = $true
  return $form
}

function New-Button([string]$Text, [int]$X, [int]$Y, [System.Windows.Forms.DialogResult]$Result) {
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $Text
  $button.Left = $X
  $button.Top = $Y
  $button.Width = 100
  $button.DialogResult = $Result
  return $button
}

try {
  $raw = [Console]::In.ReadToEnd()
  $payload = if ([string]::IsNullOrWhiteSpace($raw)) { [pscustomobject]@{} } else { ConvertFrom-Json -InputObject $raw }

  if ($Action -in @('prompt', 'confirm', 'open-file', 'save-file')) {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
  }

  switch ($Action) {
    'prompt' {
      $form = New-Dialog 'Connexease Gateway' 190
      try {
        $label = New-Object System.Windows.Forms.Label
        $label.Text = [string]$payload.label
        $label.SetBounds(20, 18, 590, 40)
        $form.Controls.Add($label)
        $answer = New-Object System.Windows.Forms.TextBox
        $answer.SetBounds(20, 62, 590, 25)
        $answer.UseSystemPasswordChar = [bool]$payload.hidden
        $form.Controls.Add($answer)
        $cancel = New-Button 'Cancel' 400 105 ([System.Windows.Forms.DialogResult]::Cancel)
        $ok = New-Button 'Continue' 510 105 ([System.Windows.Forms.DialogResult]::OK)
        $form.Controls.AddRange(@($cancel, $ok))
        $form.AcceptButton = $ok
        $form.CancelButton = $cancel
        $form.Add_Shown({ [void]$answer.Focus() })
        if ($form.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
          Write-Result 'ok' $answer.Text
        } else { Write-Result 'cancelled' $null }
      } finally { $form.Dispose() }
      break
    }
    'confirm' {
      $form = New-Dialog 'Confirm Connexease Gateway action' 490
      try {
        $label = New-Object System.Windows.Forms.Label
        $label.Text = [string]$payload.prompt
        $label.SetBounds(20, 15, 590, 115)
        $form.Controls.Add($label)
        $review = New-Object System.Windows.Forms.TextBox
        $review.Multiline = $true
        $review.ReadOnly = $true
        $review.ScrollBars = [System.Windows.Forms.ScrollBars]::Both
        $review.WordWrap = $false
        $review.Text = [string]$payload.value
        $review.SetBounds(20, 140, 590, 260)
        $form.Controls.Add($review)
        $cancel = New-Button 'Cancel' 400 410 ([System.Windows.Forms.DialogResult]::Cancel)
        $approve = New-Button ([string]$payload.approveLabel) 510 410 ([System.Windows.Forms.DialogResult]::OK)
        $form.Controls.AddRange(@($cancel, $approve))
        $form.CancelButton = $cancel
        if ($form.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
          Write-Result 'ok' $true
        } else { Write-Result 'cancelled' $null }
      } finally { $form.Dispose() }
      break
    }
    'open-file' {
      $dialog = New-Object System.Windows.Forms.OpenFileDialog
      try {
        $dialog.Title = 'Select one file to upload to Connexease Gateway'
        $dialog.Multiselect = $false
        $dialog.CheckFileExists = $true
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
          Write-Result 'ok' $dialog.FileName
        } else { Write-Result 'cancelled' $null }
      } finally { $dialog.Dispose() }
      break
    }
    'save-file' {
      $dialog = New-Object System.Windows.Forms.SaveFileDialog
      try {
        $dialog.Title = 'Save Connexease Gateway insights CSV'
        $dialog.FileName = [string]$payload.filename
        $dialog.Filter = 'CSV files (*.csv)|*.csv'
        $dialog.OverwritePrompt = $true
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
          Write-Result 'ok' $dialog.FileName
        } else { Write-Result 'cancelled' $null }
      } finally { $dialog.Dispose() }
      break
    }
    default {
      Add-Type -AssemblyName System.Security
      $directory = Join-Path $env:LOCALAPPDATA 'Connexease\GatewayAI'
      $path = Join-Path $directory 'refresh.dpapi'
      $entropy = [Text.Encoding]::UTF8.GetBytes('connexease-gateway-ai-ops-v1')
      $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
      if ($Action -eq 'token-write') {
        if ([string]::IsNullOrWhiteSpace([string]$payload.token)) { throw 'Invalid token' }
        [void][IO.Directory]::CreateDirectory($directory)
        $plain = [Text.Encoding]::UTF8.GetBytes([string]$payload.token)
        try {
          $protected = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, $scope)
          $temporary = Join-Path $directory ([Guid]::NewGuid().ToString('N') + '.tmp')
          try {
            [IO.File]::WriteAllBytes($temporary, $protected)
            if ([IO.File]::Exists($path)) { [IO.File]::Replace($temporary, $path, $null) }
            else { [IO.File]::Move($temporary, $path) }
          } finally {
            if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
          }
        } finally { [Array]::Clear($plain, 0, $plain.Length) }
        Write-Result 'ok' $null
      } elseif ($Action -eq 'token-read') {
        if (-not [IO.File]::Exists($path)) { Write-Result 'missing' $null }
        else {
          $protected = [IO.File]::ReadAllBytes($path)
          $plain = [Security.Cryptography.ProtectedData]::Unprotect($protected, $entropy, $scope)
          try { Write-Result 'ok' ([Text.Encoding]::UTF8.GetString($plain)) }
          finally { [Array]::Clear($plain, 0, $plain.Length) }
        }
      } elseif ($Action -eq 'token-delete') {
        if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) }
        Write-Result 'ok' $null
      }
    }
  }
} catch {
  # Do not echo PowerShell exception text: it could include credential input.
  Write-Result 'error' $null
  exit 1
}
