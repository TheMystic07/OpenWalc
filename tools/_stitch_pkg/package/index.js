#!/usr/bin/env node

/**
 * stitch-mcp - Universal MCP Server for Google Stitch
 * 
 * robust, cross-platform implementation.
 */

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");
const os = require("os");
const fetch = require("node-fetch");

const execAsync = promisify(exec);

const STITCH_URL = "https://stitch.googleapis.com/mcp";
const TIMEOUT_MS = 180000; // 3 minutes

// Helpers for formatted logging
const log = {
    info: (msg) => console.error(`[stitch-mcp] ℹ️  ${msg}`),
    success: (msg) => console.error(`[stitch-mcp] ✅ ${msg}`),
    warn: (msg) => console.error(`[stitch-mcp] ⚠️  ${msg}`),
    error: (msg) => console.error(`[stitch-mcp] ❌ ${msg}`),
};

// Cross-platform gcloud execution
async function runGcloud(params) {
    const isWin = os.platform() === "win32";
    const command = isWin ? "gcloud.cmd" : "gcloud";
    const fullCommand = `${command} ${params}`;

    try {
        const { stdout } = await execAsync(fullCommand, {
            encoding: "utf8",
            maxBuffer: 10 * 1024 * 1024, // 10MB buffer
            timeout: 10000, // 10s timeout for CLI commands
            windowsHide: true
        });
        return stdout.trim();
    } catch (error) {
        // Enhance error message
        const msg = error.message || error.toString();
        if (msg.includes("ENOENT") || msg.includes("not recognized")) {
            throw new Error(`gcloud CLI not found. Please install Google Cloud SDK.`);
        }
        if (msg.includes("Reauthentication required") || msg.includes("Credentials")) {
            throw new Error(`Authentication expired. Run: gcloud auth application-default login`);
        }
        throw error;
    }
}

async function getAccessToken() {
    try {
        return await runGcloud("auth application-default print-access-token");
    } catch (error) {
        log.error("Failed to get access token");
        throw error;
    }
}

async function getProjectId() {
    // 1. Env var
    if (process.env.GOOGLE_CLOUD_PROJECT) return process.env.GOOGLE_CLOUD_PROJECT;
    if (process.env.GCLOUD_PROJECT) return process.env.GCLOUD_PROJECT;

    // 2. gcloud config
    try {
        const project = await runGcloud("config get-value project");
        if (project && project !== "(unset)") {
            return project;
        }
    } catch (e) { /* ignore */ }

    throw new Error("Project ID not found. Set GOOGLE_CLOUD_PROJECT env var or run: gcloud config set project YOUR_PROJECT");
}

async function callStitchAPI(method, params, projectId) {
    const token = await getAccessToken();

    const body = {
        jsonrpc: "2.0",
        method,
        params,
        id: Date.now()
    };

    log.info(`→ ${method}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const response = await fetch(STITCH_URL, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "X-Goog-User-Project": projectId,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });

        clearTimeout(timeout);

        if (!response.ok) {
            const text = await response.text();
            let errorMessage = `HTTP ${response.status}: ${text}`;
            let errorCode = -32000; // Default server error

            // Map HTTP errors to JSON-RPC errors
            if (response.status === 400) errorCode = -32602; // Invalid params
            if (response.status === 401 || response.status === 403) errorCode = -32001; // Auth error
            if (response.status === 404) errorCode = -32601; // Method not found

            throw { code: errorCode, message: errorMessage };
        }

        const data = await response.json();
        log.success(`Completed ${method}`);
        return data;

    } catch (error) {
        clearTimeout(timeout);
        if (error.name === 'AbortError') throw { code: -32002, message: "Request timeout (3 minutes)" };
        if (error.code) throw error; // Already formatted
        throw { code: -32603, message: error.message || "Internal error" };
    }
}

/**
 * Recursively removes non-standard x-* vendor extension keywords
 * from JSON Schema objects. Google's Stitch API includes proprietary
 * keys like "x-google-identifier" that cause strict-mode validators
 * (e.g. Ajv in Augment Code) to reject the schema.
 */
function sanitizeSchema(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(item => sanitizeSchema(item));

    const cleaned = {};
    for (const key of Object.keys(obj)) {
        if (key.startsWith('x-')) continue;
        cleaned[key] = sanitizeSchema(obj[key]);
    }
    return cleaned;
}

async function main() {
    try {
        log.info(`Starting Stitch MCP Server v1.0.0 (${os.platform()})`);

        // 1. Startup Checks
        const projectId = await getProjectId();
        log.info(`Project: ${projectId}`);

        try {
            await getAccessToken();
            log.success("Auth verified");
        } catch (e) {
            throw new Error("Authentication failed. Run: gcloud auth application-default login");
        }

        // 2. Setup Server
        const server = new Server(
            { name: "stitch", version: "1.0.0" },
            { capabilities: { tools: {} } }
        );

        const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

        // 3. Handlers
        let cachedTools = null;

        const CUSTOM_TOOLS = [
            {
                name: "fetch_screen_code",
                description: "Retrieves the actual HTML/Code content of a screen. Use this when you need to SEE the code.",
                inputSchema: {
                    type: "object",
                    properties: {
                        projectId: { type: "string", description: "The project ID" },
                        screenId: { type: "string", description: "The screen ID" }
                    },
                    required: ["projectId", "screenId"]
                }
            },
            {
                name: "fetch_screen_image",
                description: "Retrieves the screenshot/preview image of a screen.",
                inputSchema: {
                    type: "object",
                    properties: {
                        projectId: { type: "string", description: "The project ID" },
                        screenId: { type: "string", description: "The screen ID" }
                    },
                    required: ["projectId", "screenId"]
                }
            }
        ];

        server.setRequestHandler(ListToolsRequestSchema, async () => {
            // Always fetch fresh list to ensure connectivity, but we can cache if needed
            try {
                const result = await callStitchAPI("tools/list", {}, projectId);
                const rawTools = result.result ? result.result.tools : [];
                // Sanitize inputSchema to remove x-google-* and other vendor extensions
                // that cause strict-mode JSON Schema validators to reject the tools
                const tools = rawTools.map(tool => ({
                    ...tool,
                    inputSchema: tool.inputSchema
                        ? sanitizeSchema(tool.inputSchema)
                        : tool.inputSchema
                }));
                return { tools: [...tools, ...CUSTOM_TOOLS] };
            } catch (error) {
                log.error(`Tools list failed: ${error.message}`);
                // Return empty list instead of crashing, but log error
                return { tools: [...CUSTOM_TOOLS] };
            }
        });

        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

            // --- CUSTOM HANDLERS ---
            if (name === "fetch_screen_code") {
                try {
                    log.info(`Fetching code for screen: ${args.screenId}`);
                    const screenRes = await callStitchAPI("tools/call", {
                        name: "get_screen",
                        arguments: { projectId: args.projectId, screenId: args.screenId }
                    }, projectId);

                    if (!screenRes.result) throw new Error("Could not fetch screen details");

                    let downloadUrl = null;
                    const findUrl = (obj) => {
                        if (downloadUrl) return;
                        if (!obj || typeof obj !== 'object') return;
                        if (obj.downloadUrl) { downloadUrl = obj.downloadUrl; return; }
                        for (const key in obj) findUrl(obj[key]);
                    };
                    findUrl(screenRes.result);

                    if (!downloadUrl) return { content: [{ type: "text", text: "No code download URL found." }], isError: true };

                    const res = await fetch(downloadUrl);
                    if (!res.ok) throw new Error(`Failed to download: ${res.status}`);
                    const code = await res.text();
                    return { content: [{ type: "text", text: code }] };

                } catch (err) {
                    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
                }
            }

            if (name === "fetch_screen_image") {
                try {
                    log.info(`Fetching image for screen: ${args.screenId}`);
                    const screenRes = await callStitchAPI("tools/call", {
                        name: "get_screen",
                        arguments: { projectId: args.projectId, screenId: args.screenId }
                    }, projectId);

                    if (!screenRes.result) throw new Error("Could not fetch screen details");

                    let imageUrl = null;
                    const findImg = (obj) => {
                        if (imageUrl) return;
                        if (!obj || typeof obj !== 'object') return;

                        // Priority 1: Explicit Screenshot field structure
                        if (obj.screenshot && obj.screenshot.downloadUrl) {
                            imageUrl = obj.screenshot.downloadUrl; return;
                        }

                        // Priority 2: Generic URI check
                        const isImgUrl = (s) => typeof s === "string" && (
                            s.includes(".png") ||
                            s.includes(".jpg") ||
                            (s.includes("googleusercontent.com") && !s.includes("contribution.usercontent"))
                        );

                        if (obj.downloadUrl && isImgUrl(obj.downloadUrl)) { imageUrl = obj.downloadUrl; return; }
                        if (obj.uri && isImgUrl(obj.uri)) { imageUrl = obj.uri; return; }

                        // Priority 3: Check "downloadUrl" in "files" that look like images
                        if (obj.name && (obj.name.includes("png") || obj.name.includes("jpg")) && obj.downloadUrl) {
                            imageUrl = obj.downloadUrl; return;
                        }

                        for (const key in obj) findImg(obj[key]);
                    };
                    findImg(screenRes.result);

                    if (!imageUrl) return { content: [{ type: "text", text: "No image URL found." }], isError: true };

                    // DOWNLOAD AND SAVE
                    log.info(`Downloading image from: ${imageUrl}`);
                    const imgRes = await fetch(imageUrl);
                    if (!imgRes.ok) throw new Error(`Failed to download image: ${imgRes.status}`);

                    const arrayBuffer = await imgRes.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);
                    const fileName = `screen_${args.screenId}.png`;
                    const filePath = path.join(process.cwd(), fileName);

                    fs.writeFileSync(filePath, buffer);
                    log.info(`Saved image to: ${filePath}`);

                    const base64Img = buffer.toString('base64');

                    return {
                        content: [
                            { type: "text", text: `Image saved to ${fileName}` },
                            { type: "image", data: base64Img, mimeType: "image/png" }
                        ]
                    };

                } catch (err) {
                    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
                }
            }

            if (name === "extract_design_context") {
                try {
                    log.info(`Extracting design context for: ${args.screenId}`);

                    // 1. Get Code
                    const screenRes = await callStitchAPI("tools/call", {
                        name: "get_screen",
                        arguments: { projectId: args.projectId, screenId: args.screenId }
                    }, projectId);

                    if (!screenRes.result) throw new Error("Could not fetch screen details");

                    let html = null;
                    const findHtml = (obj) => {
                        if (html) return;
                        if (!obj || typeof obj !== 'object') return;
                        if (obj.htmlCode && obj.htmlCode.content) { html = obj.htmlCode.content; return; }
                        for (const k in obj) findHtml(obj[k]);
                    };
                    findHtml(screenRes.result);

                    if (!html) return { content: [{ type: "text", text: "HTML content not found in screen data." }], isError: true };

                    // 2. Extract DNA
                    let fullPrompt = "Based on the following design system:\n\n";

                    // A: Tailwind Config
                    const tailwindMatch = html.match(/tailwind\.config\s*=\s*({[\s\S]*?})\s*<\/script>/);
                    if (tailwindMatch) {
                        const cleanConfig = tailwindMatch[1].replace(/\s+/g, ' ').trim();
                        fullPrompt += `### Design Tokens (Tailwind)\nUse these EXACT colors and fonts:\n\`\`\`json\n${cleanConfig}\n\`\`\`\n\n`;
                    }

                    // B: Components
                    // We look for common markers like TopAppBar, BottomNavigation, etc.
                    const sections = [
                        { name: 'Header/TopBar', regex: /<!--\s*TopAppBar\s*-->([\s\S]*?)<!--/ },
                        { name: 'Bottom Navigation', regex: /<!--\s*BottomNavigation\s*-->([\s\S]*?)<!--/ },
                        { name: 'Floating Action Button', regex: /<!--\s*Floating Action Button\s*-->([\s\S]*?)<\/div>/ }
                    ];

                    let foundComponents = 0;
                    sections.forEach(s => {
                        const m = html.match(s.regex);
                        if (m) {
                            foundComponents++;
                            fullPrompt += `### ${s.name} Style\nReplicate this structure:\n\`\`\`html\n${m[1].trim()}\n\`\`\`\n\n`;
                        }
                    });

                    if (foundComponents === 0) {
                        fullPrompt += "### UI Style\n(No explicit Header or Nav comments found. Refer to previous screen screenshot for layout.)\n";
                    }

                    return {
                        content: [
                            { type: "text", text: fullPrompt }
                        ]
                    };

                } catch (err) {
                    return { content: [{ type: "text", text: `Error extracting context: ${err.message}` }], isError: true };
                }
            }
            // -----------------------

            try {
                const result = await callStitchAPI("tools/call", { name, arguments: args || {} }, projectId);

                // --- AUTO-DOWNLOAD MAGIC ---
                // Recursively find "downloadUrl" and fetch content
                if (result.result) {
                    try {
                        const processObject = async (obj) => {
                            if (!obj || typeof obj !== 'object') return;

                            // Check for downloadUrl in current object
                            if (obj.downloadUrl && typeof obj.downloadUrl === 'string') {
                                try {
                                    log.info(`Auto-downloading content from: ${obj.downloadUrl.substring(0, 50)}...`);
                                    const res = await fetch(obj.downloadUrl);
                                    if (res.ok) {
                                        const text = await res.text();
                                        obj.content = text; // Inject content
                                        log.success("Content downloaded and injected!");
                                    } else {
                                        log.error(`Failed to download: ${res.status}`);
                                    }
                                } catch (err) {
                                    log.error(`Download error: ${err.message}`);
                                }
                            }

                            // Recurse into children
                            for (const key in obj) {
                                await processObject(obj[key]);
                            }
                        };

                        await processObject(result.result);
                    } catch (e) {
                        log.error(`Magic processing failed: ${e.message}`);
                        // Don't fail the whole request, just return original result
                    }
                }
                // ---------------------------

                if (result.result) {
                    // Check if result is already valid MCP content
                    if (result.result.content && Array.isArray(result.result.content)) {
                        return result.result;
                    }
                    // Otherwise wrap raw JSON in text content
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify(result.result, null, 2)
                        }]
                    };
                }
                if (result.error) return { content: [{ type: "text", text: `API Error: ${result.error.message}` }], isError: true };
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            } catch (error) {
                log.error(`Tool ${name} failed: ${error.message}`);
                return {
                    content: [{ type: "text", text: `Error: ${error.message}` }],
                    isError: true
                };
            }
        });

        server.onerror = (err) => log.error(`Server error: ${err}`);

        // 4. Connect
        const transport = new StdioServerTransport();
        await server.connect(transport);
        log.success("Server ready and listening on stdio");

    } catch (error) {
        log.error(`Fatal Startup Error: ${error.message}`);
        process.exit(1);
    }
}

main();
