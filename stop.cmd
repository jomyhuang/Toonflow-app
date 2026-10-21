@echo off
rem 停止 Toonflow 定制版容器（数据保留，用 start.cmd 再次启动）
cd /d "%~dp0"
docker compose stop
echo Toonflow 已停止；数据与配置保留，重新启动请运行 start.cmd
