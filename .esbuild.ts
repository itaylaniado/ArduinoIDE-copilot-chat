/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as watcher from '@parcel/watcher';
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import { copyFile, mkdir, readdir, rename } from 'fs/promises';
import { glob } from 'glob';
import * as path from 'path';

const REPO_ROOT = typeof __dirname !== 'undefined' ? __dirname : (import.meta.dirname || process.cwd());
const isWatch = process.argv.includes('--watch');
const isDev = process.argv.includes('--dev');
const isPreRelease = process.argv.includes('--prerelease');
const generateSourceMaps = process.argv.includes('--sourcemaps');
const sourceMapOutDir = './dist-sourcemaps';

const baseBuildOptions = {
	bundle: true,
	logLevel: 'info',
	minify: !isDev,
	outdir: './dist',
	// In dev mode, use linked source maps for debugging.
	// With --sourcemaps flag, generate external source maps (no sourceMappingURL comment in output).
	sourcemap: isDev ? 'linked' : (generateSourceMaps ? 'external' : false),
	sourcesContent: false,
	treeShaking: true
} satisfies esbuild.BuildOptions;

const baseNodeBuildOptions = {
	...baseBuildOptions,
	external: [
		'./package.json',
		'./.vscode-test.mjs',
		'playwright',
		'keytar',
		'@azure/functions-core',
		'applicationinsights-native-metrics',
		'@opentelemetry/instrumentation',
		'@azure/opentelemetry-instrumentation-azure-sdk',
		'electron', // this is for simulation workbench,
		'sqlite3',
		'node-pty', // Required by @github/copilot
		'@github/copilot',
		...(isDev ? [] : ['dotenv', 'source-map-support'])
	],
	platform: 'node',
	mainFields: ["module", "main"], // needed for jsonc-parser,
	define: {
		'process.env.APPLICATIONINSIGHTS_CONFIGURATION_CONTENT': JSON.stringify(JSON.stringify({
			proxyHttpUrl: "",
			proxyHttpsUrl: ""
		}))
	},
} satisfies esbuild.BuildOptions;

const webviewBuildOptions = {
	...baseBuildOptions,
	platform: 'browser',
	target: 'es2024', // Electron 34 -> Chrome 132 -> ES2024
	entryPoints: [
		{ in: 'src/extension/completions-core/vscode-node/extension/src/copilotPanel/webView/suggestionsPanelWebview.ts', out: 'suggestionsPanelWebview' },
	],
} satisfies esbuild.BuildOptions;

const nodeExtHostTestGlobs = [
	'src/**/vscode/**/*.test.{ts,tsx}',
	'src/**/vscode-node/**/*.test.{ts,tsx}',
	// deprecated
	'src/extension/**/*.test.{ts,tsx}'
];

const testBundlePlugin: esbuild.Plugin = {
	name: 'testBundlePlugin',
	setup(build) {
		build.onResolve({ filter: /[\/\\]test-extension\.ts$/ }, args => {
			if (args.kind !== 'entry-point') {
				return;
			}
			return { path: path.resolve(args.path) };
		});
		build.onLoad({ filter: /[\/\\]test-extension\.ts$/ }, async args => {
			let files = await glob(nodeExtHostTestGlobs, { cwd: REPO_ROOT, posix: true, ignore: ['src/extension/completions-core/**/*'] });
			files = files.map(f => path.posix.relative('src', f));
			if (files.length === 0) {
				throw new Error('No extension tests found');
			}
			return {
				contents: files
					.map(f => `require('./${f}');`)
					.join(''),
				watchDirs: files.map(path.dirname),
				watchFiles: files,
			};
		});
	}
};

const nodeExtHostSanityTestGlobs = [
	'src/**/vscode-node/**/*.sanity-test.{ts,tsx}',
];

const sanityTestBundlePlugin: esbuild.Plugin = {
	name: 'sanityTestBundlePlugin',
	setup(build) {
		build.onResolve({ filter: /[\/\\]sanity-test-extension\.ts$/ }, args => {
			if (args.kind !== 'entry-point') {
				return;
			}
			return { path: path.resolve(args.path) };
		});
		build.onLoad({ filter: /[\/\\]sanity-test-extension\.ts$/ }, async args => {
			let files = await glob(nodeExtHostSanityTestGlobs, { cwd: REPO_ROOT, posix: true, ignore: ['src/extension/completions-core/**/*'] });
			files = files.map(f => path.posix.relative('src', f));
			if (files.length === 0) {
				throw new Error('No extension tests found');
			}
			return {
				contents: files
					.map(f => `require('./${f}');`)
					.join(''),
				watchDirs: files.map(path.dirname),
				watchFiles: files,
			};
		});
	}
};

const importMetaPlugin: esbuild.Plugin = {
	name: 'claudeAgentSdkImportMetaPlugin',
	setup(build) {
		// Handle import.meta.url in @anthropic-ai/claude-agent-sdk package
		build.onLoad({ filter: /node_modules[\/\\]@anthropic-ai[\/\\]claude-agent-sdk[\/\\].*\.mjs$/ }, async (args) => {
			const contents = await fs.promises.readFile(args.path, 'utf8');
			return {
				contents: contents.replace(
					/import\.meta\.url/g,
					'require("url").pathToFileURL(__filename).href'
				),
				loader: 'js'
			};
		});
	}
};

const shimVsCodeTypesPlugin: esbuild.Plugin = {
	name: 'shimVsCodeTypesPlugin',
	setup(build) {
		// Create a virtual module that will try to require vscode at runtime
		build.onResolve({ filter: /^vscode$/ }, args => {
			return {
				path: 'vscode-dynamic',
				namespace: 'vscode-fallback'
			};
		});

		build.onLoad({ filter: /^vscode-dynamic$/, namespace: 'vscode-fallback' }, () => {
			return {
				contents: `
					let vscode;
					// See test/simulationExtension/extension.js for where and why this is created.
					if (typeof COPILOT_SIMULATION_VSCODE !== 'undefined') {
						vscode = COPILOT_SIMULATION_VSCODE;
					} else {
						try {
							vscode = eval('require(' + JSON.stringify('vscode') + ')');
						} catch (e) {
							vscode = require('./src/util/common/test/shims/vscodeTypesShim.ts');
						}
					}
					module.exports = vscode;
				`,
				resolveDir: REPO_ROOT
			};
		});
	}
};

const shimSqlitePlugin: esbuild.Plugin = {
	name: 'shimSqlitePlugin',
	setup(build) {
		build.onResolve({ filter: /^node:sqlite$/ }, () => {
			return {
				path: path.resolve(REPO_ROOT, 'src/util/common/shims/nodeSqliteShim.ts')
			};
		});
	}
};

const nodeExtHostBuildOptions = {
	...baseNodeBuildOptions,
	entryPoints: [
		{ in: './src/extension/extension/vscode-node/extension.ts', out: 'extension' },
		{ in: './src/platform/parser/node/parserWorker.ts', out: 'worker2' },
		{ in: './src/platform/tokenizer/node/tikTokenizerWorker.ts', out: 'tikTokenizerWorker' },
		{ in: './src/platform/diff/node/diffWorkerMain.ts', out: 'diffWorker' },
		{ in: './src/platform/tfidf/node/tfidfWorker.ts', out: 'tfidfWorker' },
		{ in: './src/extension/onboardDebug/node/copilotDebugWorker/index.ts', out: 'copilotDebugCommand' },
		{ in: './src/extension/chatSessions/vscode-node/copilotCLIShim.ts', out: 'copilotCLIShim' },
		{ in: './src/test-extension.ts', out: 'test-extension' },
		{ in: './src/sanity-test-extension.ts', out: 'sanity-test-extension' },
	],
	loader: { '.ps1': 'text' },
	plugins: [testBundlePlugin, sanityTestBundlePlugin, importMetaPlugin, shimSqlitePlugin],
	external: [
		...baseNodeBuildOptions.external,
		'vscode'
	],
	banner: {
		js: `
// Polyfill VS Code proposed APIs and enums for Arduino IDE / Theia compatibility
(function() {
	try {
		const _vsc = require('vscode');
		if (_vsc) {
			if (!_vsc.ChatEditingSessionActionOutcome) {
				_vsc.ChatEditingSessionActionOutcome = { Accepted: 1, Rejected: 2, Saved: 3 };
			}
			if (!_vsc.ChatResultFeedbackKind) {
				_vsc.ChatResultFeedbackKind = { Unhelpful: 0, Helpful: 1 };
			}
			if (!_vsc.InlineCompletionEndOfLifeReasonKind) {
				_vsc.InlineCompletionEndOfLifeReasonKind = { Accepted: 0, Rejected: 1, Ignored: 2 };
			}
			if (!_vsc.RelatedInformationType) {
				_vsc.RelatedInformationType = { CommandInformation: 1, SettingInformation: 2 };
			}
			if (!_vsc.ChatLocation) {
				_vsc.ChatLocation = { Panel: 1, Terminal: 2, Editor: 3, Notebook: 4 };
			}
			if (!_vsc.ChatSessionStatus) {
				_vsc.ChatSessionStatus = { InProgress: 1, Completed: 2, Failed: 3 };
			}
			if (!_vsc.ChatVariableLevel) {
				_vsc.ChatVariableLevel = { Short: 1, Medium: 2, Full: 3 };
			}
			if (!_vsc.ChatDebugLogLevel) {
				_vsc.ChatDebugLogLevel = { Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 };
			}
			if (!_vsc.ChatDebugToolCallResult) {
				_vsc.ChatDebugToolCallResult = { Success: 1, Error: 2 };
			}
			if (!_vsc.ChatDebugSubagentStatus) {
				_vsc.ChatDebugSubagentStatus = { Running: 1, Completed: 2, Failed: 3 };
			}
			if (!_vsc.ChatDebugHookResult) {
				_vsc.ChatDebugHookResult = { Success: 1, Error: 2, NonBlockingError: 3 };
			}
			if (!_vsc.ChatSessionCustomizationType) {
				_vsc.ChatSessionCustomizationType = { Agent: 1, Skill: 2, Instructions: 3, Hook: 4, Plugins: 5 };
			}
			if (!_vsc.InlineCompletionDisplayLocationKind) {
				_vsc.InlineCompletionDisplayLocationKind = { Code: 1, Label: 2 };
			}
			if (!_vsc.InlineCompletionsDisposeReasonKind) {
				_vsc.InlineCompletionsDisposeReasonKind = { NotTaken: 0, LostRace: 1, TokenCancellation: 2 };
			}
			if (!_vsc.LanguageModelChatMessageRole) {
				_vsc.LanguageModelChatMessageRole = { User: 1, Assistant: 2, System: 3 };
			}
			if (!_vsc.LanguageModelChatToolMode) {
				_vsc.LanguageModelChatToolMode = { Auto: 1, Required: 2 };
			}
			if (!_vsc.SettingsSearchResultKind) {
				_vsc.SettingsSearchResultKind = { EXACT_MATCH: 1, SYNONYM: 2, EMBEDDED: 3, LLM_RANKED: 4 };
			}
			if (!_vsc.ThemeIcon) {
				const _ThemeIcon = class {
					constructor(id, color) {
						this.id = id;
						this.color = color;
					}
				};
				_ThemeIcon.File = new _ThemeIcon('file');
				_ThemeIcon.Folder = new _ThemeIcon('folder');
				_vsc.ThemeIcon = _ThemeIcon;
			}
			if (!_vsc.ThemeColor) {
				_vsc.ThemeColor = class {
					constructor(id) {
						this.id = id;
					}
				};
			}
			function _patchProperty(parent, prop, stubs) {
				if (!parent) return;
				const current = parent[prop];
				if (!current) {
					const target = Object.assign({}, stubs);
					try {
						parent[prop] = target;
					} catch {
						Object.defineProperty(parent, prop, {
							value: target,
							writable: true,
							configurable: true,
							enumerable: true
						});
					}
					return;
				}

				const overrides = Object.assign({}, stubs);

				const proxy = new Proxy({}, {
					get(_target, p, receiver) {
						if (typeof p === 'string' && p in overrides) {
							return overrides[p];
						}
						const val = Reflect.get(current, p);
						return typeof val === 'function' ? val.bind(current) : val;
					},
					set(_target, p, value) {
						if (typeof p === 'string') {
							overrides[p] = value;
						}
						return true;
					},
					has(_target, p) {
						return (typeof p === 'string' && p in overrides) || p in current;
					}
				});

				try {
					parent[prop] = proxy;
				} catch {
					Object.defineProperty(parent, prop, {
						value: proxy,
						writable: true,
						configurable: true,
						enumerable: true
					});
				}
			}

			_patchProperty(_vsc, 'chat', {
				createChatParticipant: () => ({
					onDidReceiveFeedback: () => ({ dispose: () => {} }),
					onDidPerformAction: () => ({ dispose: () => {} }),
					dispose: () => {},
					iconPath: undefined,
					supportIssueReporting: false
				}),
				registerChatSessionItemProvider: () => ({ dispose: () => {} }),
				registerChatSessionContentProvider: () => ({ dispose: () => {} }),
				registerChatSessionCustomizationProvider: () => ({ dispose: () => {} }),
				registerChatParticipantDetectionProvider: () => ({ dispose: () => {} }),
				registerCustomAgentProvider: () => ({ dispose: () => {} }),
				registerInstructionsProvider: () => ({ dispose: () => {} }),
				registerMappedEditsProvider2: () => ({ dispose: () => {} }),
				registerChatDebugLogProvider: () => ({ dispose: () => {} }),
				createChatSessionItemController: () => ({ dispose: () => {} }),
				onDidChangeCustomAgents: () => ({ dispose: () => {} }),
				onDidChangeInstructions: () => ({ dispose: () => {} }),
				onDidChangeSkills: () => ({ dispose: () => {} }),
				onDidChangeHooks: () => ({ dispose: () => {} }),
				onDidChangePlugins: () => ({ dispose: () => {} }),
				customAgents: [],
				instructions: [],
				skills: [],
				hooks: [],
				plugins: []
			});

			if (!_vsc.ai) {
				_vsc.ai = {
					registerRelatedInformationProvider: () => ({ dispose: () => {} }),
					registerSettingsSearchProvider: () => ({ dispose: () => {} })
				};
			}

			const _lmStubs = {
				selectChatModels: async () => [],
				registerLanguageModelChatProvider: () => ({ dispose: () => {} }),
				registerTool: () => ({ dispose: () => {} }),
				invokeTool: async () => ({ content: [] }),
				tools: [],
				onDidChangeTools: () => ({ dispose: () => {} }),
				mcpServerDefinitions: [],
				onDidChangeMcpServerDefinitions: () => ({ dispose: () => {} }),
				startMcpGateway: async () => undefined
			};
			const _lmProxy = new Proxy(_lmStubs, {
				get(target, p) {
					if (typeof p === 'string') {
						if (p in target) {
							return target[p];
						}
						if (p.startsWith('register') || p.startsWith('onDidChange')) {
							return () => ({ dispose: () => {} });
						}
					}
					return target[p];
				}
			});

			_patchProperty(_vsc, 'lm', _lmProxy);

			const _powerStubs = {
				onDidSuspend: () => ({ dispose: () => {} }),
				onDidResume: () => ({ dispose: () => {} }),
				onDidChangeOnBatteryPower: () => ({ dispose: () => {} }),
				onDidChangeThermalState: () => ({ dispose: () => {} }),
				onDidChangeSpeedLimit: () => ({ dispose: () => {} }),
				onWillShutdown: () => ({ dispose: () => {} }),
				onDidLockScreen: () => ({ dispose: () => {} }),
				onDidUnlockScreen: () => ({ dispose: () => {} }),
				isOnBatteryPower: async () => false,
				getCurrentThermalState: async () => 'nominal',
				getSystemIdleTime: async () => 0,
				startPowerSaveBlocker: async () => ({ id: 1, dispose: () => {} })
			};
			const _powerProxy = new Proxy(_powerStubs, {
				get(target, p) {
					if (typeof p === 'string') {
						if (p in target) {
							return target[p];
						}
						if (p.startsWith('onDid') || p.startsWith('onWill')) {
							return () => ({ dispose: () => {} });
						}
					}
					return target[p];
				}
			});

			_patchProperty(_vsc, 'env', {
				createTelemetryLogger: (sender, options) => ({
					onDidChangeEnableStates: () => ({ dispose: () => {} }),
					isUsageEnabled: true,
					isErrorsEnabled: true,
					logUsage: (eventName, data) => {
						try { sender?.sendEventData?.(eventName, data); } catch {}
					},
					logError: (errorOrEventName, data) => {
						try {
							if (typeof errorOrEventName === 'string') {
								sender?.sendEventData?.(errorOrEventName, data);
							} else {
								sender?.sendErrorData?.(errorOrEventName, data);
							}
						} catch {}
					},
					dispose: () => {}
				}),
				getDataChannel: (channelName) => ({
					channelName,
					onDidReceiveData: () => ({ dispose: () => {} }),
					postMessage: () => {},
					dispose: () => {}
				}),
				power: _powerProxy
			});

			if (!_vsc.l10n) {
				_vsc.l10n = {
					t: (msg, ...args) => {
						if (typeof msg === 'string') {
							let str = msg;
							for (let i = 0; i < args.length; i++) {
								str = str.replace('{' + i + '}', String(args[i]));
							}
							return str;
						}
						return (msg && msg.message) || String(msg || '');
					}
				};
			}

			_patchProperty(_vsc, 'authentication', {
				getSession: async () => undefined,
				registerAuthenticationProvider: () => ({ dispose: () => {} }),
				onDidChangeSessions: () => ({ dispose: () => {} })
			});

			_patchProperty(_vsc, 'debug', {
				registerDebugAdapterTrackerFactory: () => ({ dispose: () => {} }),
				onDidStartDebugSession: () => ({ dispose: () => {} }),
				onDidTerminateDebugSession: () => ({ dispose: () => {} }),
				activeDebugSession: undefined
			});

			_patchProperty(_vsc, 'window', {
				onDidExecuteTerminalCommand: () => ({ dispose: () => {} }),
				onDidChangeTerminalState: () => ({ dispose: () => {} }),
				onDidWriteTerminalData: () => ({ dispose: () => {} }),
				onDidCloseTerminal: () => ({ dispose: () => {} }),
				createChatStatusItem: (id) => ({
					id,
					title: '',
					description: '',
					detail: undefined,
					show: () => {},
					hide: () => {},
					dispose: () => {}
				}),
				tabGroups: {
					all: [],
					activeTabGroup: undefined,
					onDidChangeTabGroups: () => ({ dispose: () => {} }),
					onDidChangeTabs: () => ({ dispose: () => {} }),
					close: async () => true
				}
			});

			_patchProperty(_vsc, 'workspace', {
				isTrusted: true,
				requestWorkspaceTrust: async () => true,
				onDidGrantWorkspaceTrust: () => ({ dispose: () => {} }),
				isAgentSessionsWorkspace: false,
				registerAITextSearchProvider: () => ({ dispose: () => {} })
			});

			_patchProperty(_vsc, 'extensions', {
				getExtension: () => undefined,
				all: [],
				onDidChange: () => ({ dispose: () => {} })
			});
			if (!_vsc.ExtensionMode) {
				_vsc.ExtensionMode = { Production: 1, Development: 2, Test: 3 };
			}
			if (!_vsc.ExtensionKind) {
				_vsc.ExtensionKind = { UI: 1, Workspace: 2 };
			}
			if (!_vsc.DiagnosticSeverity) {
				_vsc.DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
			}
			if (!_vsc.EndOfLine) {
				_vsc.EndOfLine = { LF: 1, CRLF: 2 };
			}
			if (!_vsc.FileType) {
				_vsc.FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
			}
			if (!_vsc.NotebookCellKind) {
				_vsc.NotebookCellKind = { Markup: 1, Code: 2 };
			}
			if (!_vsc.TextEditorSelectionChangeKind) {
				_vsc.TextEditorSelectionChangeKind = { Keyboard: 1, Mouse: 2, Command: 3 };
			}
			if (!_vsc.TextDocumentChangeReason) {
				_vsc.TextDocumentChangeReason = { Undo: 1, Redo: 2 };
			}
			if (!_vsc.SymbolKind) {
				_vsc.SymbolKind = { File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10, Function: 11, Variable: 12, Constant: 13, String: 14, Number: 15, Boolean: 16, Array: 17, Object: 18, Key: 19, Null: 20, EnumMember: 21, Struct: 22, Event: 23, Operator: 24, TypeParameter: 25 };
			}
			if (!_vsc.CodeAction) {
				_vsc.CodeAction = class {
					constructor(title, kind) {
						this.title = title;
						this.kind = kind;
					}
				};
			}
			if (!_vsc.CodeActionKind || typeof _vsc.CodeActionKind.QuickFix?.append !== 'function') {
				class CodeActionKindImpl {
					constructor(value) {
						this.value = value;
					}
					append(parts) {
						return new CodeActionKindImpl(this.value ? (this.value + '.' + parts) : parts);
					}
					contains(other) {
						return other && (this.value === other.value || (other.value && other.value.startsWith(this.value + '.')));
					}
					intersects(other) {
						return this.contains(other) || (other && typeof other.contains === 'function' && other.contains(this));
					}
				}
				CodeActionKindImpl.Empty = new CodeActionKindImpl('');
				CodeActionKindImpl.QuickFix = new CodeActionKindImpl('quickfix');
				CodeActionKindImpl.Refactor = new CodeActionKindImpl('refactor');
				CodeActionKindImpl.RefactorExtract = new CodeActionKindImpl('refactor.extract');
				CodeActionKindImpl.RefactorInline = new CodeActionKindImpl('refactor.inline');
				CodeActionKindImpl.RefactorRewrite = new CodeActionKindImpl('refactor.rewrite');
				CodeActionKindImpl.Source = new CodeActionKindImpl('source');
				CodeActionKindImpl.SourceOrganizeImports = new CodeActionKindImpl('source.organizeImports');
				CodeActionKindImpl.SourceFixAll = new CodeActionKindImpl('source.fixAll');
				_vsc.CodeActionKind = CodeActionKindImpl;
			}
			if (!_vsc.TreeItem) {
				_vsc.TreeItem = class {
					constructor(label, collapsibleState) {
						this.label = label;
						this.collapsibleState = collapsibleState;
					}
				};
			}
			if (!_vsc.TreeItemCollapsibleState) {
				_vsc.TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
			}
			if (!_vsc.InlineCompletionList) {
				_vsc.InlineCompletionList = class {
					constructor(items) {
						this.items = items || [];
					}
				};
			}
			if (!_vsc.InlineCompletionItem) {
				_vsc.InlineCompletionItem = class {
					constructor(insertText, range, command) {
						this.insertText = insertText;
						this.range = range;
						this.command = command;
					}
				};
			}
			if (!_vsc.InlineCompletionTriggerKind) {
				_vsc.InlineCompletionTriggerKind = { Invoke: 0, Automatic: 1 };
			}
			if (!_vsc.ConfigurationTarget) {
				_vsc.ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
			}
			if (!_vsc.ColorThemeKind) {
				_vsc.ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 };
			}
			if (!_vsc.ProgressLocation) {
				_vsc.ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
			}
			if (!_vsc.QuickPickItemKind) {
				_vsc.QuickPickItemKind = { Separator: -1, Default: 0 };
			}
			if (!_vsc.StatusBarAlignment) {
				_vsc.StatusBarAlignment = { Left: 1, Right: 2 };
			}
			if (!_vsc.LogLevel) {
				_vsc.LogLevel = { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 };
			}
			if (!_vsc.CommentMode) {
				_vsc.CommentMode = { Editing: 0, Preview: 1 };
			}
			if (!_vsc.CommentThreadCollapsibleState) {
				_vsc.CommentThreadCollapsibleState = { Collapsed: 0, Expanded: 1 };
			}
			if (!_vsc.TextEditorRevealType) {
				_vsc.TextEditorRevealType = { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 };
			}
			if (!_vsc.TextEditorCursorStyle) {
				_vsc.TextEditorCursorStyle = { Line: 1, Block: 2, Underline: 3, LineThin: 4, BlockOutline: 5, UnderlineThin: 6 };
			}
			if (!_vsc.TextEditorLineNumbersStyle) {
				_vsc.TextEditorLineNumbersStyle = { Off: 0, On: 1, Relative: 2 };
			}
			if (!_vsc.LanguageModelChatMessage) {
				_vsc.LanguageModelChatMessage = {
					User: (content, name) => ({ role: 1, content, name }),
					Assistant: (content, name) => ({ role: 2, content, name }),
					System: (content) => ({ role: 3, content })
				};
			}
			if (!_vsc.LanguageModelError) {
				_vsc.LanguageModelError = {
					Blocked: (msg) => new Error(msg),
					NotFound: (msg) => new Error(msg)
				};
			}
			if (!_vsc.LanguageModelTextPart) {
				_vsc.LanguageModelTextPart = class { constructor(value) { this.value = value; } };
			}
			if (!_vsc.LanguageModelToolCallPart) {
				_vsc.LanguageModelToolCallPart = class { constructor(callId, name, input) { this.callId = callId; this.name = name; this.input = input; } };
			}
			if (!_vsc.LanguageModelToolResultPart) {
				_vsc.LanguageModelToolResultPart = class { constructor(callId, content) { this.callId = callId; this.content = content; } };
			}
			if (_vsc.languages) {
				if (!_vsc.languages.inlineCompletionsUnificationState) {
					_vsc.languages.inlineCompletionsUnificationState = {
						codeUnification: true,
						modelUnification: false,
						extensionUnification: true,
						expAssignments: []
					};
				}
				if (!_vsc.languages.onDidChangeCompletionsUnificationState) {
					_vsc.languages.onDidChangeCompletionsUnificationState = () => ({ dispose: () => {} });
				}
			}
		}
	} catch (e) {
		// Ignore if require('vscode') fails
	}
})();
`
	}
} satisfies esbuild.BuildOptions;

const webExtHostBuildOptions = {
	...baseBuildOptions,
	platform: 'browser',
	entryPoints: [
		{ in: './src/extension/extension/vscode-worker/extension.ts', out: 'web' },
	],
	format: 'cjs', // Necessary to export activate function from bundle for extension
	external: [
		'vscode',
		'http',
	]
} satisfies esbuild.BuildOptions;

const nodeExtHostSimulationTestOptions = {
	...nodeExtHostBuildOptions,
	outdir: '.vscode/extensions/test-extension/dist',
	entryPoints: [
		{ in: '.vscode/extensions/test-extension/main.ts', out: './simulation-extension' }
	]
} satisfies esbuild.BuildOptions;

const nodeSimulationBuildOptions = {
	...baseNodeBuildOptions,
	entryPoints: [
		{ in: './test/simulationMain.ts', out: 'simulationMain' },
	],
	plugins: [testBundlePlugin, shimVsCodeTypesPlugin],
	external: [
		...baseNodeBuildOptions.external,
	]
} satisfies esbuild.BuildOptions;

const nodeSimulationWorkbenchUIBuildOptions = {
	...baseNodeBuildOptions,
	platform: 'browser', // @ulugbekna: important to target 'browser' for correct bundling using 'window'
	mainFields: ["browser", "module", "main"],
	entryPoints: [
		{ in: './test/simulation/workbench/simulationWorkbench.tsx', out: 'simulationWorkbench' },
	],
	alias: {
		'vscode': './src/util/common/test/shims/vscodeTypesShim.ts'
	},
	external: [
		...baseNodeBuildOptions.external,

		'../../node_modules/monaco-editor/*',

		// @ulugbekna: libs provided by node that need to be specified manually because of 'platform' is set to 'browser'
		'fs',
		'path',
		'readline',
		'child_process',
		'http',
		'assert',
	],
} satisfies esbuild.BuildOptions;

async function typeScriptServerPluginPackageJsonInstall(): Promise<void> {
	await mkdir('./node_modules/@vscode/copilot-typescript-server-plugin', { recursive: true });
	const source = path.join(REPO_ROOT, './src/extension/typescriptContext/serverPlugin/package.json');
	const destination = path.join(REPO_ROOT, './node_modules/@vscode/copilot-typescript-server-plugin/package.json');
	try {
		await copyFile(source, destination);
	} catch (error) {
		console.error('Error copying package.json:', error);
	}
}

const typeScriptServerPluginBuildOptions = {
	bundle: true,
	format: 'cjs',
	// keepNames: true,
	logLevel: 'info',
	minify: !isDev,
	outdir: './node_modules/@vscode/copilot-typescript-server-plugin/dist',
	platform: 'node',
	sourcemap: isDev ? 'linked' : false,
	sourcesContent: false,
	treeShaking: true,
	external: [
		"typescript",
		"typescript/lib/tsserverlibrary"
	],
	entryPoints: [
		{ in: './src/extension/typescriptContext/serverPlugin/src/node/main.ts', out: 'main' },
	]
} satisfies esbuild.BuildOptions;

/**
 * Moves all .map files from the output directories to a separate source maps directory.
 * This keeps source maps out of the packaged extension while making them available for upload.
 */
async function moveSourceMapsToSeparateDir(): Promise<void> {
	if (!generateSourceMaps) {
		return;
	}

	const outputDirs = [
		'./dist',
		'./node_modules/@vscode/copilot-typescript-server-plugin/dist',
	];

	await mkdir(sourceMapOutDir, { recursive: true });

	for (const dir of outputDirs) {
		try {
			const files = await readdir(dir);
			for (const file of files) {
				if (file.endsWith('.map')) {
					const sourcePath = path.join(dir, file);
					// Prefix with directory name to avoid collisions
					const prefix = dir === './dist' ? '' : 'ts-plugin-';
					const destPath = path.join(sourceMapOutDir, prefix + file);
					await rename(sourcePath, destPath);
					console.log(`Moved source map: ${sourcePath} -> ${destPath}`);
				}
			}
		} catch (error) {
			// Directory might not exist in some build configurations
			console.warn(`Could not process directory ${dir}:`, error);
		}
	}
}

async function generateWebviewAssets(): Promise<void> {
	const webviewDir = path.join(REPO_ROOT, 'src', 'extension', 'arduino', 'webview');
	const css = fs.readFileSync(path.join(webviewDir, 'main.css'), 'utf8');
	const js = fs.readFileSync(path.join(webviewDir, 'main.js'), 'utf8');
	const code = '/* Auto-generated by build */\n' +
		'export const DEFAULT_MAIN_CSS = ' + JSON.stringify(css) + ';\n' +
		'export const DEFAULT_MAIN_JS = ' + JSON.stringify(js) + ';\n';
	fs.writeFileSync(path.join(webviewDir, 'webviewAssets.ts'), code, 'utf8');
}

async function main() {
	if (!isDev) {
		applyPackageJsonPatch(isPreRelease);
	}

	await generateWebviewAssets();
	await typeScriptServerPluginPackageJsonInstall();

	if (isWatch) {

		const contexts: esbuild.BuildContext[] = [];

		const nodeExtHostContext = await esbuild.context(nodeExtHostBuildOptions);
		contexts.push(nodeExtHostContext);

		const webExtHostContext = await esbuild.context(webExtHostBuildOptions);
		contexts.push(webExtHostContext);

		const nodeSimulationContext = await esbuild.context(nodeSimulationBuildOptions);
		contexts.push(nodeSimulationContext);

		const nodeSimulationWorkbenchUIContext = await esbuild.context(nodeSimulationWorkbenchUIBuildOptions);
		contexts.push(nodeSimulationWorkbenchUIContext);

		const nodeExtHostSimulationContext = await esbuild.context(nodeExtHostSimulationTestOptions);
		contexts.push(nodeExtHostSimulationContext);

		const typeScriptServerPluginContext = await esbuild.context(typeScriptServerPluginBuildOptions);
		contexts.push(typeScriptServerPluginContext);

		let debounce: NodeJS.Timeout | undefined;

		const rebuild = async () => {
			if (debounce) {
				clearTimeout(debounce);
			}

			debounce = setTimeout(async () => {
				console.log('[watch] build started');
				for (const ctx of contexts) {
					try {
						await ctx.cancel();
						await ctx.rebuild();
					} catch (error) {
						console.error('[watch]', error);
					}
				}
				console.log('[watch] build finished');
			}, 100);
		};


		watcher.subscribe(REPO_ROOT, (err, events) => {
			for (const event of events) {
				console.log(`File change detected: ${event.path}`);
			}
			rebuild();
		}, {
			ignore: [
				`**/.git/**`,
				`**/.simulation/**`,
				`**/test/outcome/**`,
				`.vscode-test/**`,
				`**/.venv/**`,
				`**/dist/**`,
				`**/node_modules/**`,
				`**/*.txt`,
				`**/baseline.json`,
				`**/baseline.old.json`,
				`**/*.w.json`,
				'**/*.sqlite',
				'**/*.sqlite-journal',
				'test/aml/out/**'
			]
		});
		rebuild();
	} else {
		await Promise.all([
			esbuild.build(nodeExtHostBuildOptions),
			esbuild.build(webExtHostBuildOptions),
			esbuild.build(nodeSimulationBuildOptions),
			esbuild.build(nodeSimulationWorkbenchUIBuildOptions),
			esbuild.build(nodeExtHostSimulationTestOptions),
			esbuild.build(typeScriptServerPluginBuildOptions),
			esbuild.build(webviewBuildOptions),
		]);

		// Copy webview assets into dist/ so they can be inlined at runtime
		const webviewSrcDir = path.join(REPO_ROOT, 'src', 'extension', 'arduino', 'webview');
		await copyFile(path.join(webviewSrcDir, 'main.css'), path.join(REPO_ROOT, 'dist', 'main.css'));
		await copyFile(path.join(webviewSrcDir, 'main.js'), path.join(REPO_ROOT, 'dist', 'main.js'));

		// Move source maps to separate directory so they're not packaged with the extension
		await moveSourceMapsToSeparateDir();
	}
}

function applyPackageJsonPatch(isPreRelease: boolean) {
	const packagejsonPath = path.join(REPO_ROOT, './package.json');
	const json = JSON.parse(fs.readFileSync(packagejsonPath).toString());

	const newProps: any = {
		buildType: 'prod',
		isPreRelease,
	};

	const patchedPackageJson = Object.assign(json, newProps);

	// Remove fields which might reveal our development process
	delete patchedPackageJson['scripts'];
	delete patchedPackageJson['devDependencies'];
	delete patchedPackageJson['dependencies'];

	fs.writeFileSync(packagejsonPath, JSON.stringify(patchedPackageJson));
}

main();
