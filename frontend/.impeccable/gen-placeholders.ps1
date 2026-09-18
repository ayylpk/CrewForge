# 生成两张占位图（真图按提示词清单放入 src/assets 同名文件即覆盖）
Add-Type -AssemblyName System.Drawing
$assets = Join-Path $PSScriptRoot "..\src\assets"

# 1) sheet-login-flow.png 2400x1600 蓝晒底 + 白线网格 + 章形示意
$w = 2400; $h = 1600
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(255, 21, 94, 147))
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(38, 255, 255, 255), 2)
for ($x = 0; $x -le $w; $x += 120) { $g.DrawLine($pen, $x, 0, $x, $h) }
for ($y = 0; $y -le $h; $y += 120) { $g.DrawLine($pen, 0, $y, $w, $y) }
$wp = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(120, 255, 255, 255), 4)
$g.DrawEllipse($wp, 420, 480, 640, 640)
$g.DrawRectangle($wp, 1400, 420, 520, 380)
$g.DrawLine($wp, 1060, 800, 1400, 610)
$g.Dispose()
$bmp.Save((Join-Path $assets "sheet-login-flow.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

# 2) sheet-empty-draft.png 1200x900 纸底 + 双线图框 + 空白标题栏
$w2 = 1200; $h2 = 900
$bmp2 = New-Object System.Drawing.Bitmap($w2, $h2)
$g2 = [System.Drawing.Graphics]::FromImage($bmp2)
$g2.Clear([System.Drawing.Color]::FromArgb(255, 233, 238, 242))
$p1 = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 22, 34, 46), 3)
$p2 = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(160, 22, 34, 46), 1)
$g2.DrawRectangle($p1, 24, 24, ($w2 - 48), ($h2 - 48))
$g2.DrawRectangle($p2, 34, 34, ($w2 - 68), ($h2 - 68))
$g2.DrawRectangle($p2, ($w2 - 334), ($h2 - 134), 280, 80)
$g2.Dispose()
$bmp2.Save((Join-Path $assets "sheet-empty-draft.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp2.Dispose()
Write-Output "placeholders done"
