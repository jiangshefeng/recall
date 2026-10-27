$ErrorActionPreference = 'Stop'
$ragRoot = $PSScriptRoot
$ollamaExe = 'D:\Ollama\ollama.exe'
$env:OLLAMA_MODELS = 'D:\Ollama\models'
$env:OLLAMA_HOST = '127.0.0.1:11434'

try { $null = Invoke-RestMethod 'http://127.0.0.1:11434/api/version' -TimeoutSec 2 }
catch {
    if (-not (Test-Path -LiteralPath $ollamaExe)) { throw 'Ollama was not found at D:\Ollama\ollama.exe' }
    Start-Process -FilePath $ollamaExe -ArgumentList 'serve' -WorkingDirectory 'D:\Ollama' -WindowStyle Hidden `
        -RedirectStandardOutput 'D:\Ollama\server.log' -RedirectStandardError 'D:\Ollama\server-error.log'
    $ragOllamaReady = $false
    for ($ragAttempt = 0; $ragAttempt -lt 20; $ragAttempt++) {
        Start-Sleep -Milliseconds 500
        try { $null = Invoke-RestMethod 'http://127.0.0.1:11434/api/version' -TimeoutSec 2; $ragOllamaReady = $true; break } catch {}
    }
    if (-not $ragOllamaReady) { throw 'Ollama did not start. See D:\Ollama\server-error.log' }
}

$ragExistingListener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($ragExistingListener) {
    $ragExistingApp = Invoke-RestMethod 'http://127.0.0.1:3000/api/memories?scope=default' -TimeoutSec 5
    if (-not $ragExistingApp.config) { throw 'Port 3000 is occupied by another application.' }
    Write-Output 'Recall is already running: http://127.0.0.1:3000'
} else {
    $ragNode = (Get-Command node.exe).Source
    Start-Process -FilePath $ragNode -ArgumentList @('node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1') `
        -WorkingDirectory $ragRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $ragRoot 'dev.log') `
        -RedirectStandardError (Join-Path $ragRoot 'dev-error.log')
    Write-Output 'Recall is starting: http://127.0.0.1:3000'
}
Write-Output 'Fill LLM_API_KEY in .env.local with your mainland DashScope API key, then refresh the page.'
