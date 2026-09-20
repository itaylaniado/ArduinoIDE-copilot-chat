/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import test, { describe, it } from 'node:test';

import { KNOWN_BOARDS } from '../services/boardContextService.ts';
import { SketchService } from '../services/sketchService.ts';
import { SerialTelemetryService } from '../services/serialTelemetryService.ts';
import { ArduinoFixErrorsTool } from '../tools/arduinoFixErrorsTool.ts';
import { ArduinoCircuitDiagramTool } from '../tools/arduinoCircuitDiagramTool.ts';

describe('Arduino Core Features Verification', () => {
	it('Validates Board Profiles and PWM pin capabilities', () => {
		const uno = KNOWN_BOARDS['arduino:avr:uno'];
		assert.strictEqual(uno.name, 'Arduino Uno');
		assert.strictEqual(uno.voltage, 5.0);
		assert.deepStrictEqual(uno.pwmPins, [3, 5, 6, 9, 10, 11]);

		const esp32 = KNOWN_BOARDS['esp32:esp32:esp32'];
		assert.strictEqual(esp32.name, 'ESP32 Dev Module');
		assert.strictEqual(esp32.voltage, 3.3);
		assert.strictEqual(esp32.architecture, 'xtensa-esp32');
	});

	it('Analyzes Sketch for blocking delay and missing F() macro', () => {
		const sketchService = new SketchService();
		const code = `
void loop() {
  Serial.println("Reading temperature sensor now...");
  delay(1000);
}
`;
		const issues = sketchService.analyzeSketch(code, 'avr');
		const delays = issues.filter(i => i.type === 'blocking_delay');
		const fMacros = issues.filter(i => i.type === 'missing_f_macro');

		assert.strictEqual(delays.length, 1);
		assert.match(delays[0].recommendation, /millis\(\)/);
		assert.strictEqual(fMacros.length, 1);
		assert.match(fMacros[0].recommendation, /F\(/);
	});

	it('Decodes ESP32 crash backtraces and panics', () => {
		const serialService = new SerialTelemetryService();
		const panicSnippet = `
Guru Meditation Error: Core 1 panic'ed (LoadProhibited). Exception was unhandled.
Backtrace:0x400d1234:0x3ffb0000 0x400d5678:0x3ffb0020
`;
		const res = serialService.decodeBacktrace(panicSnippet);
		assert.strictEqual(res.isCrash, true);
		assert.strictEqual(res.crashType, 'LoadProhibited');
		assert.strictEqual(res.core, 1);
		assert.strictEqual(res.addresses.length, 2);
		assert.strictEqual(res.addresses[0], '0x400d1234');
	});

	it('Detects Serial Monitor baud rate mismatch', () => {
		const serialService = new SerialTelemetryService();
		const gibberish = `\uFFFD\uFFFD\uFFFD\x00\x02\x03\uFFFD\uFFFD\uFFFD\uFFFD\x04\x05\uFFFD\uFFFD\uFFFD\uFFFD`;
		const sketch = `void setup() { Serial.begin(115200); }`;

		const check = serialService.checkBaudRate(gibberish, sketch);
		assert.strictEqual(check.hasMismatch, true);
		assert.strictEqual(check.suggestedBaud, 115200);
	});

	it('Parses compiler diagnostics and detects missing libraries', async () => {
		const mockCli = {
			findCliPath: async () => '/bin/arduino-cli',
			compile: async () => ({ success: false, compilerOutput: '', errorOutput: '/tmp/sketch.ino.cpp:25:10: fatal error: DHT.h: No such file or directory' }),
			upload: async () => ({ success: true, output: '' }),
			listDetectedBoards: async () => [],
			searchLibraries: async () => [],
			installLibrary: async () => ({ success: true, message: '' }),
			searchCores: async () => [],
			installCore: async () => ({ success: true, message: '' })
		} as any;

		const mockBoard = {
			getActiveBoard: () => KNOWN_BOARDS['arduino:avr:uno']
		} as any;

		const mockSketch = {
			getActiveSketchFolder: () => '/path/to/sketch'
		} as any;

		const fixTool = new ArduinoFixErrorsTool(mockCli, mockBoard, mockSketch);
		const result = await fixTool.execute();

		assert.strictEqual(result.hasErrors, true);
		assert.strictEqual(result.diagnostics.length, 1);
		assert.strictEqual(result.diagnostics[0].isMissingLibrary, true);
		assert.strictEqual(result.diagnostics[0].suggestedLibrary, 'DHT');
	});

	it('Generates wiring tables and ASCII schematic for DHT sensor', async () => {
		const mockBoard = {
			getActiveBoard: () => KNOWN_BOARDS['arduino:avr:uno'],
			getProfile: () => KNOWN_BOARDS['arduino:avr:uno']
		} as any;

		const circuitTool = new ArduinoCircuitDiagramTool(mockBoard);
		const result = await circuitTool.execute({ componentName: 'DHT22' });

		assert.ok(result.wiringTable.length >= 3);
		assert.match(result.mermaidDiagram, /graph LR/);
		assert.match(result.asciiDiagram, /VCC/);
	});
});
