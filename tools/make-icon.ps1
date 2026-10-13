Add-Type -AssemblyName System.Drawing

# Draws the logo, an envelope and a broom on a teal tile, on a 256-unit grid. The PNG is the site's icon and logo (also
# the one for Google's consent screen), the ICO is for the Windows executable.
$web = Join-Path $PSScriptRoot '..\app'
$out = Join-Path $PSScriptRoot '..\shell'

function P([float]$x, [float]$y) { New-Object Drawing.PointF $x, $y }
function Rgb([string]$hex) { [Drawing.ColorTranslator]::FromHtml($hex) }

function New-RoundedRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $path = New-Object Drawing.Drawing2D.GraphicsPath
    $path.AddArc($x, $y, 2 * $r, 2 * $r, 180, 90)
    $path.AddArc($x + $w - 2 * $r, $y, 2 * $r, 2 * $r, 270, 90)
    $path.AddArc($x + $w - 2 * $r, $y + $h - 2 * $r, 2 * $r, 2 * $r, 0, 90)
    $path.AddArc($x, $y + $h - 2 * $r, 2 * $r, 2 * $r, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-RoundPen([string]$hex, [float]$width) {
    $pen = New-Object Drawing.Pen (Rgb $hex), $width
    $pen.StartCap = [Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [Drawing.Drawing2D.LineJoin]::Round
    return $pen
}

function New-Logo([int]$size) {
    $bmp = New-Object Drawing.Bitmap $size, $size
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([Drawing.Color]::Transparent)
    $g.ScaleTransform($size / 256, $size / 256)

    $teal = New-Object Drawing.Drawing2D.LinearGradientBrush (P 0 0), (P 256 256), (Rgb '#0F766E'), (Rgb '#14B8A6')
    $g.FillPath($teal, (New-RoundedRect 0 0 256 256 58))

    $g.FillPath([Drawing.Brushes]::White, (New-RoundedRect 36 70 140 98 14.7))
    $g.DrawLines((New-RoundPen '#0F766E' 12.25), [Drawing.PointF[]]@((P 48 84), (P 106 121), (P 164 84)))

    # The broom leans over the envelope's corner, sweeping it.
    $g.TranslateTransform(186, 152)
    $g.RotateTransform(35)
    $wood = New-Object Drawing.SolidBrush (Rgb '#92400E')
    $g.FillPath($wood, (New-RoundedRect -7 -104 14 100 7))
    $g.FillPath($wood, (New-RoundedRect -18 -12 36 16 5))
    $bristles = New-Object Drawing.Drawing2D.GraphicsPath
    $bristles.AddLines([Drawing.PointF[]]@((P -18 4), (P 18 4), (P 36 64)))
    $bristles.AddBezier((P 36 64), (P 12 72), (P -12 72), (P -36 64))
    $bristles.CloseFigure()
    $g.FillPath((New-Object Drawing.SolidBrush (Rgb '#FBBF24')), $bristles)
    $slit = New-RoundPen '#D97706' 5
    $g.DrawLine($slit, (P -8 14), (P -17 60))
    $g.DrawLine($slit, (P 0 14), (P 0 66))
    $g.DrawLine($slit, (P 8 14), (P 17 60))

    $g.Dispose()
    return $bmp
}

# Windows renders small icons more reliably from classic DIB frames than PNG ones.
function ConvertTo-Dib($bmp) {
    $w = $bmp.Width; $h = $bmp.Height
    $ms = New-Object IO.MemoryStream
    $bw = New-Object IO.BinaryWriter $ms
    $bw.Write([uint32]40); $bw.Write([int32]$w); $bw.Write([int32]($h * 2))
    $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]0)
    $bw.Write([uint32]($w * $h * 4))
    $bw.Write([int32]0); $bw.Write([int32]0); $bw.Write([uint32]0); $bw.Write([uint32]0)

    for ($y = $h - 1; $y -ge 0; $y--) {
        for ($x = 0; $x -lt $w; $x++) {
            $c = $bmp.GetPixel($x, $y)
            $bw.Write([byte]$c.B); $bw.Write([byte]$c.G)
            $bw.Write([byte]$c.R); $bw.Write([byte]$c.A)
        }
    }

    $stride = [math]::Floor(($w + 31) / 32) * 4
    $bw.Write((New-Object byte[] ($stride * $h)))
    $bw.Flush()
    return $ms.ToArray()
}

function ConvertTo-Png($bmp) {
    $ms = New-Object IO.MemoryStream
    $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
    return $ms.ToArray()
}

$png = New-Logo 256
$png.Save((Join-Path $web 'icon.png'), [Drawing.Imaging.ImageFormat]::Png)
$png.Dispose()

$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$frames = foreach ($s in $sizes) {
    $bmp = New-Logo $s
    $data = if ($s -ge 128) { ConvertTo-Png $bmp } else { ConvertTo-Dib $bmp }
    $bmp.Dispose()
    , $data
}

$ico = New-Object IO.MemoryStream
$w = New-Object IO.BinaryWriter $ico
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$frames.Count)
$offset = 6 + (16 * $frames.Count)
for ($i = 0; $i -lt $frames.Count; $i++) {
    $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
    $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32)
    $w.Write([uint32]$frames[$i].Length); $w.Write([uint32]$offset)
    $offset += $frames[$i].Length
}
foreach ($frame in $frames) { $ico.Write($frame, 0, $frame.Length) }
$w.Flush()
[IO.File]::WriteAllBytes((Join-Path $out 'icon.ico'), $ico.ToArray())
$w.Dispose()

'icon.ico written to shell/, icon.png written to app/'
