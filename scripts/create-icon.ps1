# Generate the GroupResume Companion app icon (.ico)
# Creates a multi-resolution icon with chat bubble design

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$projectDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$iconPath = Join-Path $projectDir "assets\icon.ico"

# Ensure assets folder exists
$assetsDir = Join-Path $projectDir "assets"
if (-not (Test-Path $assetsDir)) {
    New-Item -ItemType Directory -Path $assetsDir -Force | Out-Null
}

function Draw-AppIcon([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $scale = $size / 64.0

    # Round rect background with gradient (indigo)
    $bgPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = 8 * $scale
    $bgRect = New-Object System.Drawing.RectangleF(1, 1, ($size - 2), ($size - 2))
    $bgPath.AddArc($bgRect.X, $bgRect.Y, $r * 2, $r * 2, 180, 90)
    $bgPath.AddArc($bgRect.Right - $r * 2, $bgRect.Y, $r * 2, $r * 2, 270, 90)
    $bgPath.AddArc($bgRect.Right - $r * 2, $bgRect.Bottom - $r * 2, $r * 2, $r * 2, 0, 90)
    $bgPath.AddArc($bgRect.X, $bgRect.Bottom - $r * 2, $r * 2, $r * 2, 90, 90)
    $bgPath.CloseFigure()

    $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF(0, 0)),
        (New-Object System.Drawing.PointF($size, $size)),
        [System.Drawing.Color]::FromArgb(255, 99, 102, 241),
        [System.Drawing.Color]::FromArgb(255, 124, 58, 237)
    )
    $g.FillPath($bgBrush, $bgPath)

    # Main chat bubble (white)
    $whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $bubbleX = 12 * $scale
    $bubbleY = 10 * $scale
    $bubbleW = 40 * $scale
    $bubbleH = 28 * $scale
    $bubbleR = 6 * $scale

    $bubblePath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bubblePath.AddArc($bubbleX, $bubbleY, $bubbleR * 2, $bubbleR * 2, 180, 90)
    $bubblePath.AddArc($bubbleX + $bubbleW - $bubbleR * 2, $bubbleY, $bubbleR * 2, $bubbleR * 2, 270, 90)
    $bubblePath.AddArc($bubbleX + $bubbleW - $bubbleR * 2, $bubbleY + $bubbleH - $bubbleR * 2, $bubbleR * 2, $bubbleR * 2, 0, 90)
    $bubblePath.AddArc($bubbleX, $bubbleY + $bubbleH - $bubbleR * 2, $bubbleR * 2, $bubbleR * 2, 90, 90)
    $bubblePath.CloseFigure()
    $g.FillPath($whiteBrush, $bubblePath)

    # Bubble tail
    $tailPoints = @(
        (New-Object System.Drawing.PointF((18 * $scale), (37 * $scale))),
        (New-Object System.Drawing.PointF((14 * $scale), (48 * $scale))),
        (New-Object System.Drawing.PointF((28 * $scale), (37 * $scale)))
    )
    $g.FillPolygon($whiteBrush, $tailPoints)

    # Text lines inside bubble (indigo colored)
    $lineBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 99, 102, 241))
    $lineH = [Math]::Max(2, 3 * $scale)
    $lineR = $lineH / 2

    # Line 1
    $l1Path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $l1Path.AddArc((18 * $scale), (18 * $scale), $lineH, $lineH, 90, 180)
    $l1Path.AddArc((18 * $scale + 24 * $scale - $lineH), (18 * $scale), $lineH, $lineH, 270, 180)
    $l1Path.CloseFigure()
    $g.FillPath($lineBrush, $l1Path)

    # Line 2
    $l2Path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $l2Path.AddArc((18 * $scale), (25 * $scale), $lineH, $lineH, 90, 180)
    $l2Path.AddArc((18 * $scale + 18 * $scale - $lineH), (25 * $scale), $lineH, $lineH, 270, 180)
    $l2Path.CloseFigure()
    $g.FillPath($lineBrush, $l2Path)

    # Line 3
    $l3Path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $l3Path.AddArc((18 * $scale), (32 * $scale), $lineH, $lineH, 90, 180)
    $l3Path.AddArc((18 * $scale + 21 * $scale - $lineH), (32 * $scale), $lineH, $lineH, 270, 180)
    $l3Path.CloseFigure()
    $g.FillPath($lineBrush, $l3Path)

    # Cleanup
    $g.Dispose()
    $bgBrush.Dispose()
    $whiteBrush.Dispose()
    $lineBrush.Dispose()
    $bgPath.Dispose()
    $bubblePath.Dispose()

    return $bmp
}

# Create multi-resolution icon
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$bitmaps = @()

foreach ($s in $sizes) {
    $bitmaps += Draw-AppIcon $s
}

# Build ICO file manually (ICO format)
$ms = New-Object System.IO.MemoryStream

# ICO Header
$writer = New-Object System.IO.BinaryWriter($ms)
$writer.Write([UInt16]0)     # Reserved
$writer.Write([UInt16]1)     # Type: ICO
$writer.Write([UInt16]$bitmaps.Count)  # Number of images

# Calculate data offsets
$headerSize = 6 + ($bitmaps.Count * 16)
$currentOffset = $headerSize
$pngDataList = @()

foreach ($bmp in $bitmaps) {
    $pngStream = New-Object System.IO.MemoryStream
    $bmp.Save($pngStream, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngData = $pngStream.ToArray()
    $pngDataList += ,($pngData)
    $pngStream.Dispose()

    $w = if ($bmp.Width -ge 256) { 0 } else { $bmp.Width }
    $h = if ($bmp.Height -ge 256) { 0 } else { $bmp.Height }

    $writer.Write([byte]$w)          # Width
    $writer.Write([byte]$h)          # Height
    $writer.Write([byte]0)           # Color palette
    $writer.Write([byte]0)           # Reserved
    $writer.Write([UInt16]1)         # Color planes
    $writer.Write([UInt16]32)        # Bits per pixel
    $writer.Write([UInt32]$pngData.Length)  # Size
    $writer.Write([UInt32]$currentOffset)  # Offset

    $currentOffset += $pngData.Length
}

# Write PNG data
foreach ($pngData in $pngDataList) {
    $writer.Write($pngData)
}

# Save to file
[System.IO.File]::WriteAllBytes($iconPath, $ms.ToArray())

$writer.Dispose()
$ms.Dispose()

foreach ($bmp in $bitmaps) {
    $bmp.Dispose()
}

Write-Host "[OK] Icon created: $iconPath" -ForegroundColor Green
