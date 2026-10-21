@echo off
rem ============================================================
rem  Toonflow 定制版（Docker）一键启动
rem  - Docker 未运行时给出提示
rem  - 镜像缺失时自动构建（首次约 5-15 分钟）
rem  - 容器已在运行则幂等跳过
rem  - 服务就绪后自动打开浏览器
rem  - GLM/模型供应商配置在 data\settings.json（key 不入库）
rem ============================================================
cd /d "%~dp0"

docker info >nul 2>&1
if errorlevel 1 (
  echo [错误] Docker 未运行，请先启动 Docker Desktop 后重试。
  pause
  exit /b 1
)

docker image inspect toonflow-app-toonflow:latest >nul 2>&1
if errorlevel 1 (
  echo [首次运行] 正在构建镜像，约需 5-15 分钟...
  docker compose build
  if errorlevel 1 (
    echo [错误] 镜像构建失败，请把上方报错发给助手排查。
    pause
    exit /b 1
  )
)

echo [启动] 正在启动容器...
docker compose up -d
if errorlevel 1 (
  echo [错误] 容器启动失败，可运行 docker compose logs 查看原因。
  pause
  exit /b 1
)

echo [等待] 服务就绪中（最多 90 秒）...
powershell -NoProfile -Command "$u='http://127.0.0.1:3210/'; $ok=$false; foreach($i in 1..60){ try{ $r=Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 2; if($r.StatusCode -eq 200){$ok=$true; break} }catch{}; Start-Sleep -Milliseconds 1500 }; if($ok){ Write-Host ('[就绪] Toonflow 定制版: ' + $u); Start-Process $u } else { Write-Host '[超时] 服务未就绪，请运行 docker compose logs 查看日志' }"

powershell -NoProfile -Command "try{ $m=(Invoke-WebRequest -Uri 'http://127.0.0.1:3210/api/ai/models' -UseBasicParsing -TimeoutSec 5).Content; if($m -match 'opencodex'){ Write-Host '[文本] opencodex 已配置' } else { Write-Host '[文本] 未检测到 opencodex，检查 data\settings.json' }; if($m -match 'ipStudio'){ Write-Host '[媒体] ipStudio 已注册' } else { Write-Host '[媒体] 未检测到 ipStudio' } }catch{ Write-Host '[模型] 状态检查失败' }"
echo [提示] 出图/出视频走 IP Studio（设置 - 媒体模型），文本走 opencodex
pause
