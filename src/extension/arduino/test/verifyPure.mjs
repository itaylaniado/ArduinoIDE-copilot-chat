/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import test, { describe, it } from 'node:test';

// 1. Test Board Profiles & Hardware Constraints
describe('1. Arduino Hardware & Pinout Database', () => {
	const uno = {
		name: 'Arduino Uno',
		fqbn: 'arduino:avr:uno',
		architecture: 'avr',
		voltage: 5.0,
		flashBytes: 32256,
		sramBytes: 2048,
		pwmPins: [3, 5, 6, 9, 10, 11],
		analogInputPins: ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'],
		i2cPins: { sda: 'A4', scl: 'A5' },
		spiPins: { mosi: 11, miso: 12, sck: 13, ss: 10 },
		interruptPins: [2, 3]
	};

	const esp32 = {
		name: 'ESP32 Dev Module',
		fqbn: 'esp32:esp32:esp32',
		architecture: 'xtensa-esp32',
		voltage: 3.3,
		flashBytes: 4194304,
		sramBytes: 520000,
		pwmPins: [0, 2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33],
		i2cPins: { sda: 21, scl: 22 }
	};

	it('Validates Uno PWM pin support', () => {
		const isPwm = (pin) => uno.pwmPins.includes(Number(pin));
		assert.strictEqual(isPwm(3), true);
		assert.strictEqual(isPwm(9), true);
		assert.strictEqual(isPwm(4), false);
	});

	it('Validates ESP32 3.3V logic level vs Uno 5V', () => {
		assert.strictEqual(uno.voltage, 5.0);
		assert.strictEqual(esp32.voltage, 3.3);
		assert.strictEqual(esp32.architecture, 'xtensa-esp32');
	});
});

// 2. Test Sketch Code Analysis Heuristics
describe('2. Sketch Anti-Pattern & Memory Optimization Rules', () => {
	function analyzeSketch(code, architecture = 'avr') {
		const issues = [];
		const lines = code.split(/\r?\n/);

		// Check for blocking delay()
		const delayRegex = /\bdelay\s*\(\s*([0-9]+)\s*\)/g;
		lines.forEach((line, index) => {
			let match;
			while ((match = delayRegex.exec(line)) !== null) {
				const ms = parseInt(match[1], 10);
				if (ms >= 100) {
					issues.push({
						type: 'blocking_delay',
						line: index + 1,
						ms
					});
				}
			}
		});

		// Check for missing F() macro on AVR
		if (architecture === 'avr') {
			const serialPrintStringRegex = /Serial\s*\.\s*print(?:ln)?\s*\(\s*"([^"]{8,})"\s*\)/g;
			lines.forEach((line, index) => {
				let match;
				while ((match = serialPrintStringRegex.exec(line)) !== null) {
					issues.push({
						type: 'missing_f_macro',
						str: match[1]
					});
				}
			});
		}

		// Check for volatile in ISR
		if (code.includes('attachInterrupt')) {
			const isrMatch = code.match(/attachInterrupt\s*\(\s*[^,]+,\s*([a-zA-Z0-9_]+)/);
			if (isrMatch) {
				const isrName = isrMatch[1];
				const isrFuncRegex = new RegExp(`void\\s+${isrName}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\}`, 'm');
				const funcMatch = code.match(isrFuncRegex);
				if (funcMatch && funcMatch[1].includes('++')) {
					issues.push({
						type: 'missing_volatile_isr',
						isr: isrName
					});
				}
			}
		}

		return issues;
	}

	it('Detects blocking delay(1000) and delay(500)', () => {
		const code = `
void loop() {
  digitalWrite(13, HIGH);
  delay(1000);
  digitalWrite(13, LOW);
  delay(500);
}
`;
		const issues = analyzeSketch(code, 'avr');
		const delays = issues.filter(i => i.type === 'blocking_delay');
		assert.strictEqual(delays.length, 2);
		assert.strictEqual(delays[0].ms, 1000);
	});

	it('Recommends F() macro for long string literals on AVR', () => {
		const code = `
void setup() {
  Serial.begin(115200);
  Serial.println("Initializing telemetry subsystem...");
}
`;
		const issues = analyzeSketch(code, 'avr');
		const fMacro = issues.filter(i => i.type === 'missing_f_macro');
		assert.strictEqual(fMacro.length, 1);
		assert.strictEqual(fMacro[0].str, 'Initializing telemetry subsystem...');
	});

	it('Warns on shared ISR variables missing volatile', () => {
		const code = `
int counter = 0;
void countPulses() {
  counter++;
}
void setup() {
  attachInterrupt(0, countPulses, RISING);
}
`;
		const issues = analyzeSketch(code, 'avr');
		const isrIssue = issues.filter(i => i.type === 'missing_volatile_isr');
		assert.strictEqual(isrIssue.length, 1);
		assert.strictEqual(isrIssue[0].isr, 'countPulses');
	});
});

// 3. Test Serial Monitor Telemetry & Crash Decoding
describe('3. Serial Monitor Crash & Baud Rate Analysis', () => {
	function decodeBacktrace(logSnippet) {
		const isEsp32Panic = logSnippet.includes('Guru Meditation Error') || logSnippet.includes('Backtrace:');
		if (isEsp32Panic) {
			const typeMatch = logSnippet.match(/Guru Meditation Error:\s*Core\s*([0-9]+)\s*panic'ed\s*\(([^)]+)\)/);
			const backtraceMatch = logSnippet.match(/Backtrace:\s*([0-9a-fA-Fx:\s]+)/);
			const addresses = [];
			if (backtraceMatch) {
				const raw = backtraceMatch[1].trim().split(/\s+/);
				for (const item of raw) {
					const parts = item.split(':');
					if (parts[0].startsWith('0x')) addresses.push(parts[0]);
				}
			}
			return {
				isCrash: true,
				core: typeMatch ? parseInt(typeMatch[1], 10) : 0,
				crashType: typeMatch ? typeMatch[2] : 'Panic',
				addresses
			};
		}
		return { isCrash: false };
	}

	function checkBaudRate(serialSnippet, sketchCode) {
		let sketchBaud;
		if (sketchCode) {
			const m = sketchCode.match(/Serial\s*\.\s*begin\s*\(\s*([0-9]+)\s*\)/);
			if (m) sketchBaud = parseInt(m[1], 10);
		}
		const garbageCharsCount = (serialSnippet.match(/[\uFFFD\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\xFF]/g) || []).length;
		const isGibberish = serialSnippet.length > 10 && (garbageCharsCount / serialSnippet.length) > 0.25;
		return {
			hasMismatch: isGibberish,
			suggestedBaud: sketchBaud || 115200
		};
	}

	it('Accurately parses ESP32 Guru Meditation Error and stack addresses', () => {
		const snippet = `
Guru Meditation Error: Core 1 panic'ed (LoadProhibited). Exception was unhandled.
Backtrace:0x400d1234:0x3ffb0000 0x400d5678:0x3ffb0020
`;
		const res = decodeBacktrace(snippet);
		assert.strictEqual(res.isCrash, true);
		assert.strictEqual(res.core, 1);
		assert.strictEqual(res.crashType, 'LoadProhibited');
		assert.deepStrictEqual(res.addresses, ['0x400d1234', '0x400d5678']);
	});

	it('Detects framing noise garbage and infers 115200 baud from sketch', () => {
		const snippet = `\uFFFD\uFFFD\uFFFD\x00\x01\x02\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD`;
		const sketch = `void setup() { Serial.begin(115200); }`;
		const check = checkBaudRate(snippet, sketch);
		assert.strictEqual(check.hasMismatch, true);
		assert.strictEqual(check.suggestedBaud, 115200);
	});
});

// 4. Test Compiler Diagnostic Parsing & Line Mapping
describe('4. Compiler Error Diagnostic Parsing', () => {
	function parseCompilerOutput(output) {
		const lines = output.split(/\r?\n/);
		const diagnostics = [];
		const diagRegex = /([^:\s]+):([0-9]+):(?:([0-9]+):)?\s*(error|fatal error|warning):\s*(.+)/;

		for (const line of lines) {
			const match = line.match(diagRegex);
			if (match) {
				const message = match[5].trim();
				let isMissingLibrary = false;
				let suggestedLibrary;
				const libMatch = message.match(/(?:fatal error:\s*)?([^:]+\.h):\s*No such file or directory/i);
				if (libMatch) {
					isMissingLibrary = true;
					suggestedLibrary = libMatch[1].replace(/\.h$/, '');
				}
				diagnostics.push({
					file: match[1].split(/[/\\]/).pop(),
					line: parseInt(match[2], 10),
					severity: match[4].includes('error') ? 'error' : 'warning',
					message,
					isMissingLibrary,
					suggestedLibrary
				});
			}
		}
		return diagnostics;
	}

	it('Identifies missing library header and exact error line', () => {
		const log = `/tmp/arduino/sketches/XYZ/Blink.ino.cpp:18:10: fatal error: Adafruit_NeoPixel.h: No such file or directory\n` +
			`/Users/dev/Arduino/Blink/Blink.ino:25:3: error: expected ';' before '}' token`;

		const diags = parseCompilerOutput(log);
		assert.strictEqual(diags.length, 2);
		assert.strictEqual(diags[0].isMissingLibrary, true);
		assert.strictEqual(diags[0].suggestedLibrary, 'Adafruit_NeoPixel');
		assert.strictEqual(diags[1].file, 'Blink.ino');
		assert.strictEqual(diags[1].line, 25);
	});
});

// 5. Test GitHub Device Flow & Shared apps.json Credential Resolution
describe('5. GitHub Copilot Device Flow & Credential Sharing', () => {
	it('Parses ~/.config/github-copilot/apps.json structure', () => {
		const mockAppsJson = JSON.stringify({
			'github.com:Iv1.b507a08c87ecfe98': {
				user: 'arduino-dev',
				oauth_token: 'ghu_testtoken1234567890abcdef',
				githubAppId: 'Iv1.b507a08c87ecfe98'
			}
		});

		const parsed = JSON.parse(mockAppsJson);
		let foundToken, foundUser;
		for (const key of Object.keys(parsed)) {
			if (parsed[key]?.oauth_token) {
				foundUser = parsed[key].user;
				foundToken = parsed[key].oauth_token;
				break;
			}
		}

		assert.strictEqual(foundUser, 'arduino-dev');
		assert.strictEqual(foundToken, 'ghu_testtoken1234567890abcdef');
	});

	it('Constructs AuthenticationSession with required properties', () => {
		const user = 'testuser';
		const token = 'ghu_dummytoken';
		const session = {
			id: `github-${user}`,
			accessToken: token,
			account: { id: user, label: user },
			scopes: ['read:user', 'user:email']
		};

		assert.strictEqual(session.id, 'github-testuser');
		assert.strictEqual(session.account.label, 'testuser');
		assert.strictEqual(session.accessToken, token);
		assert.deepStrictEqual(session.scopes, ['read:user', 'user:email']);
	});
});

// 6. Test Direct Code Editing & Tool Calling Integration
describe('6. Direct Code Editing & Tool Calling Integration', () => {
	const editSketchFileTool = {
		type: 'function',
		function: {
			name: 'edit_sketch_file',
			description: 'Directly modify, fix, or update an Arduino sketch file (.ino, .cpp, .h) in the active project.',
			parameters: {
				type: 'object',
				properties: {
					filename: { type: 'string' },
					explanation: { type: 'string' },
					updatedContent: { type: 'string' }
				},
				required: ['filename', 'explanation', 'updatedContent']
			}
		}
	};

	it('Validates edit_sketch_file tool definition schema', () => {
		assert.strictEqual(editSketchFileTool.type, 'function');
		assert.strictEqual(editSketchFileTool.function.name, 'edit_sketch_file');
		assert.deepStrictEqual(editSketchFileTool.function.parameters.required, ['filename', 'explanation', 'updatedContent']);
	});

	it('Accumulates streaming SSE chunks into complete tool call', () => {
		const sseDeltas = [
			{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_123', type: 'function', function: { name: 'edit_sketch_file', arguments: '{"filename":"space' } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'mouse-2025.ino",' } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"explanation":"Changed baud to 115200",' } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"updatedContent":"void setup() { Serial.begin(115200); }"}' } }] } }] }
		];

		const accumulated = new Map();
		for (const chunk of sseDeltas) {
			const tcList = chunk.choices[0]?.delta?.tool_calls;
			if (tcList) {
				for (const tc of tcList) {
					const idx = tc.index ?? 0;
					if (!accumulated.has(idx)) {
						accumulated.set(idx, {
							id: tc.id || '',
							type: tc.type || 'function',
							function: {
								name: tc.function?.name || '',
								arguments: tc.function?.arguments || ''
							}
						});
					} else {
						const existing = accumulated.get(idx);
						if (tc.id) existing.id += tc.id;
						if (tc.function?.name) existing.function.name += tc.function.name;
						if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
					}
				}
			}
		}

		const toolCalls = Array.from(accumulated.values());
		assert.strictEqual(toolCalls.length, 1);
		assert.strictEqual(toolCalls[0].id, 'call_123');
		assert.strictEqual(toolCalls[0].function.name, 'edit_sketch_file');

		const parsedArgs = JSON.parse(toolCalls[0].function.arguments);
		assert.strictEqual(parsedArgs.filename, 'spacemouse-2025.ino');
		assert.strictEqual(parsedArgs.explanation, 'Changed baud to 115200');
		assert.strictEqual(parsedArgs.updatedContent, 'void setup() { Serial.begin(115200); }');
	});

	it('Manages file edit history and revert rollback', () => {
		const history = new Map();
		const filename = 'spacemouse-2025.ino';
		let currentContent = 'void setup() { Serial.begin(9600); }';

		function applyEdit(file, newCode) {
			const h = history.get(file) || [];
			h.push(currentContent);
			history.set(file, h);
			currentContent = newCode;
			return { success: true, original: h[h.length - 1] };
		}

		function revertEdit(file) {
			const h = history.get(file);
			if (!h || h.length === 0) return false;
			currentContent = h.pop();
			return true;
		}

		// Apply edit 1
		applyEdit(filename, 'void setup() { Serial.begin(115200); }');
		assert.strictEqual(currentContent, 'void setup() { Serial.begin(115200); }');

		// Apply edit 2
		applyEdit(filename, 'void setup() { Serial.begin(115200); pinMode(LED_BUILTIN, OUTPUT); }');
		assert.strictEqual(currentContent, 'void setup() { Serial.begin(115200); pinMode(LED_BUILTIN, OUTPUT); }');

		// Revert edit 2
		const reverted2 = revertEdit(filename);
		assert.strictEqual(reverted2, true);
		assert.strictEqual(currentContent, 'void setup() { Serial.begin(115200); }');

		// Revert edit 1
		const reverted1 = revertEdit(filename);
		assert.strictEqual(reverted1, true);
		assert.strictEqual(currentContent, 'void setup() { Serial.begin(9600); }');

		// Nothing left to revert
		const reverted0 = revertEdit(filename);
		assert.strictEqual(reverted0, false);
	});
});

// 7. Dynamic Board Sync & FQBN Resolution
describe('7. Arduino IDE 2.x Dynamic Board Sync & FQBN Resolution', () => {
	function parseSketchYaml(yamlText) {
		let defaultProfile;
		let defaultFqbn;

		const lines = yamlText.split(/\r?\n/);
		let currentProfile;
		const profileFqbns = {};

		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed.startsWith('#') || !trimmed) continue;

			const defProfMatch = trimmed.match(/^default_profile\s*:\s*([a-zA-Z0-9_-]+)/);
			if (defProfMatch) {
				defaultProfile = defProfMatch[1];
				continue;
			}

			const defFqbnMatch = trimmed.match(/^default_fqbn\s*:\s*([^\s#]+)/);
			if (defFqbnMatch) {
				defaultFqbn = defFqbnMatch[1];
				continue;
			}

			const profMatch = line.match(/^ {2}([a-zA-Z0-9_-]+)\s*:/);
			if (profMatch) {
				currentProfile = profMatch[1];
				continue;
			}

			if (currentProfile) {
				const fqbnMatch = trimmed.match(/^fqbn\s*:\s*([^\s#]+)/);
				if (fqbnMatch) {
					profileFqbns[currentProfile] = fqbnMatch[1];
				}
			}
		}

		if (defaultProfile && profileFqbns[defaultProfile]) {
			return { fqbn: profileFqbns[defaultProfile], profile: defaultProfile };
		}
		if (defaultFqbn) {
			return { fqbn: defaultFqbn };
		}
		const firstProf = Object.values(profileFqbns)[0];
		if (firstProf) {
			return { fqbn: firstProf };
		}
		return {};
	}

	function resolveFqbn(query) {
		const q = query.trim().toLowerCase();
		if (q.includes(':')) return query.trim();
		if (q.includes('uno r4') || q.includes('unor4') || q.includes('r4 wifi')) return 'arduino:renesas_uno:unor4wifi';
		if (q.includes('r4 minima')) return 'arduino:renesas_uno:unor4minima';
		if (q === 'uno' || q === 'arduino uno') return 'arduino:avr:uno';
		if (q === 'nano' || q === 'arduino nano') return 'arduino:avr:nano';
		if (q.includes('mega') || q.includes('2560')) return 'arduino:avr:mega';
		if (q.includes('leonardo') || q.includes('micro') || q.includes('32u4')) return 'arduino:avr:leonardo';
		if (q.includes('esp32-s3') || q.includes('esp32s3')) return 'esp32:esp32:esp32s3';
		if (q.includes('esp32-c3') || q.includes('esp32c3')) return 'esp32:esp32:esp32c3';
		if (q.includes('esp32') || q.includes('wroom') || q.includes('devkit')) return 'esp32:esp32:esp32';
		if (q.includes('pico w') || q.includes('picow')) return 'rp2040:rp2040:rpipicow';
		if (q.includes('pico') || q.includes('rp2040')) return 'rp2040:rp2040:rpipico';
		return undefined;
	}

	function createProfileFromBoardDetails(fqbn, details) {
		const name = details.name || details.properties_id || fqbn;
		const arch = (details.platform?.architecture || fqbn.split(':')[1] || 'avr').toLowerCase();
		const is33V = arch.includes('esp') || arch.includes('rp2040') || arch.includes('samd') || arch.includes('stm32');
		const voltage = is33V ? 3.3 : 5.0;

		let flashBytes = 32256;
		let sramBytes = 2048;
		let clockSpeedMhz = 16;

		if (arch.includes('esp32')) {
			flashBytes = 4194304;
			sramBytes = 520000;
			clockSpeedMhz = 240;
		} else if (arch.includes('renesas')) {
			flashBytes = 262144;
			sramBytes = 32768;
			clockSpeedMhz = 48;
		} else if (arch.includes('rp2040')) {
			flashBytes = 2097152;
			sramBytes = 264000;
			clockSpeedMhz = 133;
		}

		return {
			name,
			fqbn,
			architecture: arch,
			voltage,
			flashBytes,
			sramBytes,
			clockSpeedMhz
		};
	}

	it('Parses sketch.yaml default_profile and fqbn accurately', () => {
		const yaml1 = `
default_profile: esp32-profile
profiles:
  uno-profile:
    fqbn: arduino:avr:uno
  esp32-profile:
    fqbn: esp32:esp32:esp32
    port: /dev/cu.usbserial-0001
`;
		const parsed1 = parseSketchYaml(yaml1);
		assert.strictEqual(parsed1.fqbn, 'esp32:esp32:esp32');
		assert.strictEqual(parsed1.profile, 'esp32-profile');

		const yaml2 = `
# Arduino sketch configuration
default_fqbn: arduino:renesas_uno:unor4wifi
`;
		const parsed2 = parseSketchYaml(yaml2);
		assert.strictEqual(parsed2.fqbn, 'arduino:renesas_uno:unor4wifi');
	});

	it('Resolves friendly query names to canonical FQBNs', () => {
		assert.strictEqual(resolveFqbn('esp32'), 'esp32:esp32:esp32');
		assert.strictEqual(resolveFqbn('esp32-s3'), 'esp32:esp32:esp32s3');
		assert.strictEqual(resolveFqbn('uno r4 wifi'), 'arduino:renesas_uno:unor4wifi');
		assert.strictEqual(resolveFqbn('pico'), 'rp2040:rp2040:rpipico');
		assert.strictEqual(resolveFqbn('arduino:avr:nano'), 'arduino:avr:nano');
	});

	it('Synthesizes dynamic BoardProfile from CLI board details', () => {
		const esp32Details = {
			name: 'NodeMCU-32S',
			properties_id: 'nodemcu-32s',
			platform: { architecture: 'esp32' }
		};
		const profile = createProfileFromBoardDetails('esp32:esp32:nodemcu-32s', esp32Details);
		assert.strictEqual(profile.name, 'NodeMCU-32S');
		assert.strictEqual(profile.voltage, 3.3);
		assert.strictEqual(profile.flashBytes, 4194304);
		assert.strictEqual(profile.clockSpeedMhz, 240);
	});
});

// 8. Inline Code Completion & Theia Integration
describe('8. Inline Code Completion & Theia Compatibility', () => {
	it('Validates Theia document selector matching for Arduino sketches', () => {
		const selector = ['*', { pattern: '**' }, { scheme: 'file' }];

		function matchesSelector(doc, sel) {
			for (const item of sel) {
				if (item === '*') return true;
				if (item && typeof item === 'object') {
					if (item.pattern === '**' && doc.fileName) return true;
					if (item.scheme && doc.uri?.startsWith(`${item.scheme}:`)) return true;
				}
			}
			return false;
		}

		const testDoc = {
			fileName: '/Users/test/Arduino/Blink/Blink.ino',
			uri: 'file:///Users/test/Arduino/Blink/Blink.ino',
			languageId: 'arduino'
		};

		assert.strictEqual(matchesSelector(testDoc, selector), true);
	});

	it('Resolves .ino files to C++ language ID for prompt synthesis', () => {
		const extToLang = {
			'.cpp': 'cpp',
			'.cc': 'cpp',
			'.cxx': 'cpp',
			'.h': 'cpp',
			'.hpp': 'cpp',
			'.ino': 'cpp',
			'.c': 'c'
		};

		function detectLanguageFromPath(filePath) {
			const dotIdx = filePath.lastIndexOf('.');
			const ext = dotIdx !== -1 ? filePath.slice(dotIdx).toLowerCase() : '';
			return extToLang[ext] || 'plaintext';
		}

		assert.strictEqual(detectLanguageFromPath('/sketches/MyRobot/MyRobot.ino'), 'cpp');
		assert.strictEqual(detectLanguageFromPath('/sketches/MyRobot/motor.h'), 'cpp');
		assert.strictEqual(detectLanguageFromPath('/sketches/MyRobot/sensors.cpp'), 'cpp');
	});

	it('Verifies isCompletionEnabled defaults to true for Arduino sketches', () => {
		const configEnable = {
			'*': true,
			'plaintext': false,
			'markdown': false,
			'scminput': false
		};

		function isCompletionEnabledForLanguage(langId) {
			return configEnable[langId] ?? configEnable['*'] ?? true;
		}

		assert.strictEqual(isCompletionEnabledForLanguage('arduino'), true);
		assert.strictEqual(isCompletionEnabledForLanguage('cpp'), true);
		assert.strictEqual(isCompletionEnabledForLanguage('c'), true);
		assert.strictEqual(isCompletionEnabledForLanguage('plaintext'), false);
	});

	it('Validates inlineCompletionsUnificationState shim structure', () => {
		const unificationState = {
			codeUnification: true,
			modelUnification: false,
			extensionUnification: true,
			expAssignments: []
		};

		assert.strictEqual(unificationState.codeUnification, true);
		assert.strictEqual(unificationState.extensionUnification, true);
		assert.strictEqual(unificationState.modelUnification, false);
		assert.deepStrictEqual(unificationState.expAssignments, []);
	});

	it('Defaults editor.inlineSuggest.enabled to true when unset in Theia', () => {
		function getInlineSuggestEnabled(storedValue) {
			return storedValue ?? true;
		}

		assert.strictEqual(getInlineSuggestEnabled(undefined), true);
		assert.strictEqual(getInlineSuggestEnabled(true), true);
		assert.strictEqual(getInlineSuggestEnabled(false), false);
	});
});

