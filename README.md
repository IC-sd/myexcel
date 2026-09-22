# MyExcel

[![CI](https://github.com/IC-sd/myexcel/actions/workflows/ci.yml/badge.svg)](https://github.com/IC-sd/myexcel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

一个使用 Vue、Univer 和 Node.js 构建的通用类 Excel 应用构建项目。它展示如何把表格模板转化为可以发布、填报、关联、保存和重新打开的结构化数据应用。

项目不是现成 ERP，也不针对特定公司或行业。所有内置内容均为可再生成的合成示例。

## 快速开始

要求 Node.js 24 或更高版本。

```bash
cd myexcel-platform
npm ci
npm run build
npm start
```

打开 <http://127.0.0.1:8091>，使用页面中的快速体验入口即可。默认模式不需要 Docker 或 MySQL，运行数据保存在本地 `myexcel-platform/data/` 目录。

开发与验证：

```bash
npm run dev
npm test
npm run build
```

Windows PowerShell 中也可以使用 `npm.cmd` 执行相同脚本。

## 当前能力

- 类 Excel 多工作表编辑、公式与批量粘贴；
- 设计模式和运行模式；
- 主表、明细与单元格区域绑定；
- 草稿、发布和固定发布版本；
- 本地业务记录保存、查询和原表格回填；
- 稳定 ID 表间关系、字段带出和基础汇总；
- XLSX 基础导入导出及兼容性提示；
- 可在两个实例间迁移的 `.mxapp.json` 模板包；
- 版本化 HTTP/JSON API 与 OpenAPI 说明；
- 可重复执行的懒加载包体和 100/1,000/10,000 行性能基准；
- 可选 MySQL 记录适配器。

扩展入口见 [API v1](myexcel-platform/docs/API_V1.md)、[模板包](myexcel-platform/docs/TEMPLATE_PACKAGES.md) 与 [性能基线](myexcel-platform/docs/PERFORMANCE.md)。完整边界、架构和路线见 [项目说明](myexcel-platform/README.md) 与 [当前进度](myexcel-platform/docs/PHASE1_PROGRESS.md)。

## 许可证

项目代码采用 [MIT License](LICENSE)。第三方组件保留各自许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
