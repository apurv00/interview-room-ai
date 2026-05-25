# Prints inject URLs from manifest for manual/browser MCP use
$manifest = Get-Content "$PSScriptRoot\..\modules\qa\browser\inject-manifest.json" -Raw | ConvertFrom-Json
for ($i = 0; $i -lt $manifest.urls.Count; $i++) {
  Write-Output "=== URL $i (len=$($manifest.urls[$i].Length)) ==="
  Write-Output $manifest.urls[$i]
}
