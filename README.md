# YouTube Helper

一个本地运行的 YouTube 英语学习器：粘贴视频链接后读取英文字幕，生成中文字幕，并提供双语字幕、当前句定位、单句循环、快进后退和倍速播放。

目前这是一个最小功能实现版本，后续会慢慢添加更多学习模式和辅助功能。

## 功能

- 读取 YouTube 视频英文字幕并按句整理。
- 使用 OpenAI 兼容接口生成简体中文翻译，默认配置指向 DeepSeek API。
- 翻译结果写入本地缓存，重复打开同一视频会更快。
- 支持流式分块翻译，长视频会先显示已完成的字幕块。
- 内置播放器控制：播放暂停、上一句、下一句、后退、快进、单句循环和倍速。

## 技术栈

- React 19 + Vite
- TypeScript
- Express
- youtube-transcript-plus
- Vitest

## 本地启动

安装依赖：

```bash
npm install
```

创建本地环境变量文件：

```bash
cp .env.example .env
```

在 `.env` 中填入你自己的 API key：

```bash
OPENAI_API_KEY=
```

启动前端和后端：

```bash
npm run dev
```

默认地址：

- 前端：http://127.0.0.1:5173
- 后端：http://127.0.0.1:8787

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 后端服务端口 |
| `OPENAI_API_KEY` | 空 | OpenAI 兼容接口密钥，本地必填 |
| `OPENAI_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容接口地址 |
| `OPENAI_MODEL` | `deepseek-v4-flash` | 翻译模型 |
| `TRANSLATION_CONCURRENCY` | `4` | 翻译分块并发数，范围 1-8 |
| `TRANSLATION_CHUNK_SEGMENTS` | `12` | 每个翻译块的字幕句数，范围 4-30 |
| `TRANSLATION_CHUNK_CHARS` | `1800` | 每个翻译块的字符上限，范围 600-5000 |

## 安全说明

真实密钥只应放在本地 `.env` 或其他被忽略的环境文件中。仓库只提交 `.env.example`，不会提交 `.env`、`.env.local`、`.env.production` 等文件。

## 常用命令

```bash
npm run test
npm run build
```
