$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$setup = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$form = [Windows.Forms.Form]::new()
$form.Text = $setup.title
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.AutoScaleMode = 'Font'
$form.ClientSize = [Drawing.Size]::new(575, 280)

$instructions = [Windows.Forms.Label]::new()
$instructions.SetBounds(16, 14, 540, 94)
$instructions.Text = $setup.instructions
$form.Controls.Add($instructions)
$status = [Windows.Forms.Label]::new()
$status.SetBounds(16, 114, 540, 42)
$status.Text = if ($setup.chat) { "Paired: " + $setup.chat } else { "Waiting for extension pairing on 127.0.0.1:" + $setup.port }
if ($setup.pause) { $status.Text += [Environment]::NewLine + $setup.pause }
$form.Controls.Add($status)
$token = [Windows.Forms.TextBox]::new()
$token.SetBounds(16, 165, 540, 25)
$token.ReadOnly = $true
$token.Text = $setup.token
$form.Controls.Add($token)

$copy = [Windows.Forms.Button]::new()
$copy.SetBounds(16, 217, 130, 34)
$copy.Text = 'Copy pairing token'
$copy.Add_Click({ [Windows.Forms.Clipboard]::SetText($token.Text) })
$form.Controls.Add($copy)
$disconnect = [Windows.Forms.Button]::new()
$disconnect.SetBounds(158, 217, 244, 34)
$disconnect.Text = 'Disconnect and stop pending delivery'
$disconnect.Enabled = $true
$disconnect.DialogResult = [Windows.Forms.DialogResult]::Retry
$form.Controls.Add($disconnect)
$close = [Windows.Forms.Button]::new()
$close.SetBounds(430, 217, 126, 34)
$close.Text = 'Close'
$close.DialogResult = [Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($close)
$form.CancelButton = $close
# Node hides the helper console. Windows applies that initial hidden state
# to the first top-level ShowDialog as well, so explicitly show the form.
Add-Type -Namespace ArenaWin -Name Dialog -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr handle, int command);'
$form.Add_Shown({
  [void][ArenaWin.Dialog]::ShowWindow($form.Handle, 5)
  $form.Activate()
})
try {
  $choice = $form.ShowDialog()
  if ($choice -eq [Windows.Forms.DialogResult]::Retry) { [Console]::WriteLine('disconnect') }
  else { [Console]::WriteLine('close') }
} finally { $form.Dispose() }
