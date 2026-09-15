param(
    [Parameter(Mandatory = $true)]
    [string]$MysqlBase,
    [string]$MysqlData = (Join-Path ([IO.Path]::GetTempPath()) 'generic-sheet-app-builder\mysql-demo-data'),
    [switch]$PrepareOnly
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskProject = Join-Path $taskRoot 'myexcel-platform'
$taskMysql = Join-Path $MysqlBase 'bin\mysql.exe'
$taskServer = Join-Path $MysqlBase 'bin\mysqld.exe'
function Test-TaskTcpPort([int]$Port) {
    $taskClient = [Net.Sockets.TcpClient]::new()
    try {
        $taskAttempt = $taskClient.ConnectAsync('127.0.0.1', $Port)
        return $taskAttempt.Wait(500) -and $taskClient.Connected
    } catch {
        return $false
    } finally {
        $taskClient.Dispose()
    }
}
if (!(Test-Path -LiteralPath $taskServer)) { throw '本机没有指定 MySQL 程序；脚本不会自动下载。' }
$taskResolvedData = [IO.Path]::GetFullPath($MysqlData)
if ((Split-Path -Leaf $taskResolvedData) -ne 'mysql-demo-data') { throw '隔离实例目录名必须为 mysql-demo-data，避免误用已有数据库目录。' }
if (!(Test-Path -LiteralPath (Join-Path $taskProject 'dist\index.html')) -and !$PrepareOnly) { throw '请先在 myexcel-platform 执行 npm.cmd run build；脚本不会自动下载依赖。' }
$taskListener = Test-TaskTcpPort 13307
if (!$taskListener) {
    if (!(Test-Path -LiteralPath $taskResolvedData)) {
        New-Item -ItemType Directory -Path $taskResolvedData | Out-Null
        & $taskServer --no-defaults --initialize-insecure "--basedir=$MysqlBase" "--datadir=$taskResolvedData" --console
        if ($LASTEXITCODE -ne 0) { throw '测试数据库初始化失败；保留目录供排查。' }
    } elseif (!(Test-Path -LiteralPath (Join-Path $taskResolvedData 'auto.cnf'))) { throw '已有目录不是可识别的数据库目录，拒绝初始化覆盖。' }
    $taskArgs = @('--no-defaults', ('--basedir="{0}"' -f $MysqlBase), ('--datadir="{0}"' -f $taskResolvedData), '--bind-address=127.0.0.1', '--port=13307', '--mysqlx=0', '--skip-log-bin', ('--log-error="{0}"' -f (Join-Path $taskResolvedData 'startup.err')))
    Start-Process -FilePath $taskServer -ArgumentList $taskArgs -WindowStyle Hidden | Out-Null
    $taskDeadline = (Get-Date).AddSeconds(20)
    do { Start-Sleep -Milliseconds 300; $taskListener = Test-TaskTcpPort 13307 } while (!$taskListener -and (Get-Date) -lt $taskDeadline)
    if (!$taskListener) { throw '测试 MySQL 未监听 13307，请检查 startup.err。' }
}
# Validate the instance before creating the dedicated demo schema.
$taskActualData = & $taskMysql --no-defaults --host=127.0.0.1 --port=13307 --user=root --batch --raw --skip-column-names '--execute=SELECT @@datadir;'
if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($taskActualData.Trim()).TrimEnd('\') -ne $taskResolvedData.TrimEnd('\')) { throw '13307 端口不是指定测试实例；未创建演示库。' }
& $taskMysql --no-defaults --host=127.0.0.1 --port=13307 --user=root '--execute=CREATE DATABASE IF NOT EXISTS sheetapp_demo CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;'
if ($LASTEXITCODE -ne 0) { throw '专用演示库创建失败' }
$env:MYEXCEL_MYSQL_DATABASE = 'sheetapp_demo'
$env:MYEXCEL_MYSQL_HOST = '127.0.0.1'
$env:MYEXCEL_MYSQL_PORT = '13307'
$env:MYEXCEL_MYSQL_USER = 'root'
$env:MYEXCEL_MYSQL_PASSWORD = ''
$env:MYEXCEL_MYSQL_ALLOW_EMPTY_PASSWORD = '1'
$env:MYEXCEL_DATA_DIR = Join-Path $taskRoot '.runtime\generic-demo-metadata'
$env:MYEXCEL_PORT = '18092'
$env:MYEXCEL_HOST = '127.0.0.1'
Push-Location $taskProject
try {
    & node scripts/seed-business-demo.mjs
    if ($LASTEXITCODE -ne 0) { throw '演示数据准备失败，不启动应用。' }
    if (!$PrepareOnly) {
        Write-Host '通用合成演示：http://127.0.0.1:18092（演示账号见 README；禁止用于真实数据或公网）'
        & node server/index.mjs
    }
} finally { Pop-Location }
