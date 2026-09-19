# 本地开发环境

当前项目是单体 Node.js 应用，不依赖旧 Java、Python、Redis 或 Windows 计划任务环境。以下命令均从仓库根目录执行，路径保持相对，便于在 Windows、macOS 和 Linux 上复现。

## 基础开发

要求 Node.js 24 和 npm 11。首次安装可能产生较大网络下载，应先确认网络条件。

```powershell
Set-Location ./myexcel-platform
npm.cmd ci
npm.cmd test
npm.cmd run build
npm.cmd start
```

非 Windows 环境将 `npm.cmd` 替换为 `npm`。应用默认只监听 `127.0.0.1`。不配置 MySQL 时，模板、账号和业务记录都保存在 `myexcel-platform/data/` 下的本地文件中，可以直接完成设计、发布、填报和重开闭环；删除该目录即可重建合成演示环境。配置 MySQL 后仅业务记录切换到 MySQL 适配器。

## 隔离 MySQL 演示

演示脚本只接受显式提供的 MySQL 安装目录，并将测试数据限制在系统临时目录下名为 `generic-sheet-app-builder/mysql-demo-data` 的专用目录。这样可避开部分 MySQL Windows 版本对非 ASCII 数据目录的限制。它不会连接默认 3306，也不会使用已有业务数据库；也可用 `-MysqlData` 显式指定其他以 `mysql-demo-data` 结尾的隔离目录。

```powershell
./environment/start-business-demo.ps1 -MysqlBase 'C:\path\to\mysql-8.4.x'
```

启动后访问 `http://127.0.0.1:18092`。内置账号仅用于合成演示：

- `admin / Admin123!`
- `editor / Editor123!`
- `viewer / Viewer123!`

运行数据、日志、依赖和构建产物不提交 Git。MySQL 演示入口用于验证可选持久化适配器，不是首次运行前置条件。
