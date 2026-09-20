# Arduino IDE Copilot Chat

[![License: MIT](https://img.shields.io/badge/License-MIT-teal.svg)](LICENSE.txt)
[![Arduino IDE 2.x](https://img.shields.io/badge/Arduino%20IDE-2.x%20(Theia)-00979C.svg)](https://www.arduino.cc/en/software)
[![GitHub Copilot](https://img.shields.io/badge/GitHub-Copilot%20Enabled-orange.svg)](https://github.com/features/copilot)

An autonomous AI peer programming and chat extension for **Arduino IDE 2.x**, powered by GitHub Copilot and customized specifically for embedded systems, microcontrollers, and physical computing.

---

## Why Arduino Copilot Chat?

Arduino IDE 2.x is built on Eclipse Theia and Electron. Because Theia implements a subset of Visual Studio Code's extension APIs, the official GitHub Copilot Chat extension fails to activate due to missing runtime services (`PowerStateLogger`, `TelemetryLogger`, `TerminalBufferListener`, `TabsAndEditorsService`, etc.).

**Arduino IDE Copilot Chat** provides full compatibility shims for Theia while augmenting Copilot with deep, hardware-aware capabilities built around `arduino-cli` and physical microcontrollers.

---

## Key Features

### 1. Real-Time Board Synchronization
- **Live IDE Dropdown Sync**: Hooks directly into Arduino IDE 2.x's internal API (`dankeboy36.vscode-arduino-api`). When you change your target board in the top toolbar dropdown (e.g. from *Arduino Uno* to *ESP32 Dev Module* or *Arduino Uno R4 WiFi*), Copilot instantly updates its hardware context in real time.
- **`sketch.yaml` Support**: Automatically detects board profiles and configurations defined in your sketch directory.
- **Interactive Board Selector**: Click the active board chip in the chat header to open a QuickPick menu listing:
  - Physically connected USB microcontrollers with their COM/serial ports
  - All installed cores from the Arduino Boards Manager
  - Popular microcontroller presets (ESP32-S3, ESP32-C3, Pico, Uno R4, Nano, Mega, etc.)
- **Chat Intent Switching**: Type natural commands like `"set board to esp32-s3"`, `"switch board to uno r4 wifi"`, or `"use board pico"`.
- **Hardware-Aware Prompting**: Automatically informs GPT-4o of the active board's architecture, CPU clock speed, operating logic level (3.3V vs 5.0V), flash memory, dynamic SRAM limits, and pin constraints.

### 2. Direct Code Editing with Instant Rollback
- **In-Place File Modifications**: Instead of just printing suggested code blocks for manual copy-pasting, Copilot can directly modify active sketch files (`.ino`, `.cpp`, `.h`).
- **Standard IDE Undo**: Uses `vscode.WorkspaceEdit` so edits seamlessly integrate into the IDE's native Undo stack (`Cmd+Z` / `Ctrl+Z`).
- **One-Click Revert**: Every AI-applied edit renders an interactive card in chat with an **[↩ Revert Edit]** button for instant rollback.

### 3. Automated Compile & Fix Loop
- **⚡ Verify & Compile**: Invokes the bundled or system `arduino-cli` backend to verify and compile your sketch, reporting program storage (Flash) and dynamic memory (RAM) usage.
- **🛠️ Fix Errors**: Parses compiler diagnostics and line numbers, invokes Copilot with tool calling (`edit_sketch_file`), applies the fix directly to your sketch tabs, and automatically re-compiles with `arduino-cli` to verify the build succeeds.

### 4. Physical Computing & Embedded Utilities
- **📌 Check Pinout**: Validates PWM, analog input, external interrupt, I2C, and SPI pin capabilities against the active board's hardware layout (e.g. warning if connecting 5V signals to 3.3V GPIOs on ESP32 or RP2040).
- **🔌 Wire Component**: Generates ASCII circuit schematics, pinout connection tables, resistor calculations, and electrical safety notes for sensors, actuators, and displays.
- **🚀 Upload Sketch**: Initiates uploads to connected microcontrollers over serial/USB with actionable bootloader troubleshooting guidance.
- **Serial Crash Decoder**: Diagnoses ESP32 Guru Meditation Error stack traces and detects baud rate mismatches between your sketch `Serial.begin(...)` and the Serial Monitor.

### 5. Native Chat Experience
- **Arduino Themed UI**: Dark-mode interface designed with official Arduino teal and charcoal styling.
- **Clipboard Support**: Full keyboard shortcut support (`Cmd+C`, `Cmd+V`, `Cmd+A`) and native context-menu paste within Electron webviews.
- **Code Block Actions**: Syntax-highlighted code blocks with dedicated **Copy** and **Apply to Sketch** buttons.
- **Device Flow & Token Sharing**: Reads existing local Copilot credentials from `~/.config/github-copilot/apps.json` or provides standard GitHub OAuth Device Flow authentication directly in the panel.

### 6. Inline Code Completions (Ghost Text)
- **Real-Time Ghost Text Suggestions**: As you type code in your `.ino`, `.cpp`, `.c`, or `.h` sketch files, Copilot automatically streams and renders context-aware completions directly inline.
- **Press `Tab` to Accept**: Accept the suggested code with `Tab` or dismiss by continuing to type.
- **Manual Trigger**: Trigger completions at any cursor position with `Option + \` (macOS) or `Alt + \` (Windows/Linux).
- **Status Bar Integration**: Dedicated status indicator in the Arduino IDE bottom status bar allows viewing Copilot connectivity, changing completion models, and toggling suggestions on/off.
- **Fully Unified with Theia**: Integrated directly with Eclipse Theia's `registerInlineCompletionItemProvider` API so no secondary extensions are required.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       Arduino IDE 2.x                       │
│  ┌───────────────────────┐       ┌───────────────────────┐  │
│  │  Board Dropdown /     │       │  Active Sketch Editor │  │
│  │  vscode-arduino-api   │       │  (.ino, .cpp, .h)     │  │
│  └───────────┬───────────┘       └───────────▲───────────┘  │
└──────────────┼───────────────────────────────┼──────────────┘
               │ onDidChange('fqbn')           │ applyFileEdit
┌──────────────▼───────────────────────────────┴──────────────┐
│                  Arduino Copilot Extension                  │
│                                                             │
│   ┌─────────────────────────┐   ┌───────────────────────┐   │
│   │   BoardContextService   │   │     SketchService     │   │
│   │ (Hardware profiles,     │   │ (Tab manager, AST,    │   │
│   │  pinouts & constraints) │   │  revert history)      │   │
│   └───────────┬─────────────┘   └───────────▲───────────┘   │
│               │                             │               │
│   ┌───────────▼─────────────────────────────┴───────────┐   │
│   │                 CopilotCliAgentBridge               │   │
│   │   (System prompt assembly, tool dispatch loop)      │   │
│   └───────────┬─────────────────────────────▲───────────┘   │
│               │                             │               │
│   ┌───────────▼─────────────┐   ┌───────────┴───────────┐   │
│   │    ArduinoCliService    │   │   CopilotApiService   │   │
│   │  (compile, upload,      │   │ (OAuth token cache,   │   │
│   │   board details)        │   │  GPT-4o SSE streaming)│   │
│   └─────────────────────────┘   └───────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## Getting Started

### Prerequisites
- [Arduino IDE 2.x](https://www.arduino.cc/en/software) (version 2.2.0 or newer)
- Node.js (v20+ or v22+)
- An active [GitHub Copilot](https://github.com/features/copilot) subscription (Individual, Business, or Enterprise)

### Installation

#### Option A: Direct Deployment to Arduino IDE (Development)
1. Clone this repository:
   ```bash
   git clone https://github.com/itaylaniado/ArduinoIDE-copilot-chat.git
   cd ArduinoIDE-copilot-chat
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Compile the extension bundle:
   ```bash
   npx tsx .esbuild.ts --dev
   ```
4. Copy the compiled distribution to Arduino IDE's plugin directory:
   ```bash
   mkdir -p ~/.arduinoIDE/deployedPlugins/copilot-chat-0.44.0/extension/dist
   cp dist/extension.js dist/main.css dist/main.js ~/.arduinoIDE/deployedPlugins/copilot-chat-0.44.0/extension/dist/
   ```
5. Restart Arduino IDE 2.x. Open the **Arduino Copilot** view in the sidebar.

#### Option B: Build VSIX Package
```bash
npm run compile
npx @vscode/vsce package --no-dependencies
```
Install the resulting `.vsix` into Arduino IDE via `Cmd+Shift+P` $\rightarrow$ **Extensions: Install from VSIX...**.

---

## Running Tests

Run the standalone pure test suite:
```bash
node src/extension/arduino/test/verifyPure.mjs
```

The test suite covers:
- Arduino pinout and voltage logic level verification
- Sketch memory optimization heuristics (AVR `F()` macro, blocking `delay()`, ISR `volatile`)
- Serial monitor crash dump parsing (ESP32 Guru Meditation) and baud rate detection
- Compiler error diagnostic parsing
- GitHub Copilot authentication and token persistence
- Direct code editing, streaming tool delta accumulation, and revert rollback
- `sketch.yaml` profile parsing and dynamic FQBN resolution

---

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests to help improve microcontroller workflows, add support for additional hardware cores, or refine error diagnosis routines.

---

## License

This project is licensed under the [MIT License](LICENSE.txt).
Based on the VS Code Copilot Chat extension architecture. Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
