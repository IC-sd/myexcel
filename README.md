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

## 体验预览

以下画面使用全新本地目录自动生成的合成记录。

![运行模式：在表格中查看和填写记录](myexcel-platform/docs/images/runtime-demo.png)

![设计模式：配置业务字段和发布版本](myexcel-platform/docs/images/designer-demo.png)

进入工作台后，先用“设计者”体验模板配置和发布，再切换到“工作人员端”新建或打开合成记录。

## 功能矩阵

| 能力 | 设计模式 | 运行模式 |
|---|---|---|
| 表格 | 多工作表版式、公式、XLSX 基础导入导出 | 类 Excel 填写、批量粘贴、原表格回填 |
| 数据模型 | 主表/明细绑定、稳定字段与跨模板关系 | 关联选择、字段带出、基础汇总和历史查询 |
| 版本 | 保存草稿、发布、查看历史 | 使用固定发布版本保存和重开记录 |
| 扩展 | `.mxapp.json` 模板包导入导出及兼容检查 | 版本化 HTTP/JSON API；[OpenAPI](myexcel-platform/docs/API_V1.md) |
| 体验 | 键盘跳转、可见焦点、当前视图提示 | 默认本地存储，可选 MySQL 记录适配器 |

## 已知限制

- XLSX 只覆盖基础导入导出范围；导入时会显示兼容报告，不支持旧 `.xls` 和全部 Excel 高级特性。
- 暂无实时协作、完整工作流引擎、打印设计器或行业专用模块。
- Univer 工作区包体较大；当前通过按需加载保护登录首屏，并提供[可重复性能基准](myexcel-platform/docs/PERFORMANCE.md)。
- 本地 JSON 记录与 SQLite 元数据不组成一个跨文件事务；MySQL 是可选适配器，不是快速体验前提。
- 键盘增强覆盖应用外壳和常用控件，尚未承诺表格内核全面适配屏幕阅读器。

扩展入口见 [API v1](myexcel-platform/docs/API_V1.md)、[模板包](myexcel-platform/docs/TEMPLATE_PACKAGES.md) 与 [性能基线](myexcel-platform/docs/PERFORMANCE.md)。完整边界、架构和路线见 [项目说明](myexcel-platform/README.md) 与 [当前进度](myexcel-platform/docs/PHASE1_PROGRESS.md)。

## 许可证

项目代码采用 [MIT License](LICENSE)。第三方组件保留各自许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
