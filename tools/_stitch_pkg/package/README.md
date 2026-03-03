# Stitch MCP
<div align="center">

[![npm version](https://img.shields.io/npm/v/stitch-mcp.svg)](https://www.npmjs.com/package/stitch-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![MCP](https://img.shields.io/badge/MCP-Compatible-green.svg)](https://modelcontextprotocol.io)

**Universal MCP Server for Google Stitch**

</div> 

Build amazing UI/UX designs instantly with AI. Works seamlessly with Cursor, Claude, Antigravity, and any MCP-compatible editor.

Created by **Aakash Kargathara**.

---

## 🚀 How It Works

![Stitch Flowchart](https://mermaid.ink/img/pako:eNp9ks1KAzEQx19lSEEUWgR7cg_C0kop-FGsPUjtId2d7i7uJksyaS3dHnwBRQTx5qWIV28-jy-gj2B2s4JezCEf_8wvmfknKxbIEJnHIsXzGM67lwJsG2lU2-Ov5_sNXEgDu9DFOaYyRzXZgVbroDjhZBRP4YiLyPAIC_D7Nn7zaEfwtU40cUETd5qVSua4M4CBkiQDmRYwRDVHZZmHF9CUUBC3siCvCbdZUUMMjELwDcUFdFJpwvHH083n-x30pIxSdFrNVXOHVUeCP-gXcCiiRKC96vYVfvR-rdagW1RkDwUqTqgLODWUGypzfINR35qgk0ho2IKONa0mXUxFnqE1RejSiz-FD2O5sGppqtNdr2lp069LnSVp6jVm-7OmJiWv0Gu02-163lokIcXeXn79G6xTduB0-j_ImixDlfEkZN6KUYxZ-eghzrhJia2bjBuSw6UImEfKYJOZPLQedBNuP0bmxPU3MxfCuQ?bgColor=!white)

## ✨ Why this is cool
- **Zero Config**: Just login once and it works everywhere.
- **Universal**: Works on Windows, Mac, and Linux.
- **Free**: Google Stitch API is free to use.

## �️ Quick Setup (2 Minutes)

### 1. Prerequisite: Google Cloud
You need a Google Cloud project with the Stitch API enabled.

```bash
# Login to your Google Cloud
gcloud auth login

# Set your project (replace with your actual project ID)
gcloud config set project YOUR_PROJECT_ID
gcloud auth application-default set-quota-project YOUR_PROJECT_ID

# Enable the magic
gcloud beta services mcp enable stitch.googleapis.com
```

### 2. Install the Credentials
This gives `stitch-mcp` permission to talk to Google on your behalf.

```bash
gcloud auth application-default login
```

### 3. Add to Your AI Editor

Copy and paste this into your MCP config file:

**For Claude Desktop**:
`~/Library/Application Support/Claude/claude_desktop_config.json`

**For Cursor**:
Settings > MCP > Add New Server

```json
{
  "mcpServers": {
    "stitch": {
      "command": "npx",
      "args": ["-y", "stitch-mcp"],
      "env": {
         "GOOGLE_CLOUD_PROJECT": "YOUR_PROJECT_ID"
      }
    }
  }
}
```

## 🛠️ Available Tools

| Tool Name | What it does |
|-----------|--------------|
| **`extract_design_context`** | 🧠 Scans a screen to extract "Design DNA" (Fonts, Colors, Layouts). Use this to keep style consistent. |
| **`fetch_screen_code`** | 💾 Downloads the raw HTML/Frontend code of a screen. |
| **`fetch_screen_image`** | 🖼️ Downloads the high-res screenshot of a screen. |
| **`generate_screen_from_text`** | ✨ Generates a NEW screen based on your prompt (and context). |
| **`create_project`** | 📁 Creates a new workspace/project folder. |
| **`list_projects`** | 📋 Lists all your available Stitch projects. |
| **`list_screens`** | 📱 Lists all screens within a specific project. |
| **`get_project`** | 🔍 Retrieves details of a specific project. |
| **`get_screen`** | ℹ️ Gets metadata for a specific screen. |

## 💡 Pro Tip: The "Designer Flow"

To generate consistent UI, use this 2-step flow:

1.  **Extract**: "Get design context from the Home Screen..."
2.  **Generate**: "Using that context, generate a Chat Screen..."

This ensures your new screen matches your existing design system perfectly.

## 📄 License

**Apache 2.0** - Open source and free to use.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Kargatharaakash/stitch-mcp&type=date&legend=top-left)](https://www.star-history.com/#Kargatharaakash/stitch-mcp&type=date&legend=top-left)

---
*Built with ❤️ by Aakash Kargathara*
