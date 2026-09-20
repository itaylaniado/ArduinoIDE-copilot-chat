/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { BoardContextService } from '../services/boardContextService';
import { SketchService } from '../services/sketchService';
import { SerialTelemetryService } from '../services/serialTelemetryService';
import { IArduinoCliService, CompileResult, UploadResult, ArduinoDetectedBoard, LibrarySearchResult, CoreSearchResult } from '../services/arduinoCliService';
import { ArduinoCompileTool } from '../tools/arduinoCompileTool';
import { ArduinoFixErrorsTool } from '../tools/arduinoFixErrorsTool';
import { ArduinoPinoutTool } from '../tools/arduinoPinoutTool';
import { ArduinoCircuitDiagramTool } from '../tools/arduinoCircuitDiagramTool';
import { ArduinoToolsRegistry } from '../tools';

class MockArduinoCliService implements IArduinoCliService {
	declare _serviceBrand: undefined;
	async findCliPath(): Promise<string | undefined> { return '/usr/local/bin/arduino-cli'; }
	async compile(sketchPath: string, fqbn: string): Promise<CompileResult> {
		if (sketchPath.includes('error')) {
			return {
				success: false,
				compilerOutput: '',
				errorOutput: '/path/sketch.ino:10:3: error: expected \';\' before \'}\' token\n/tmp/sketch.ino.cpp:25:10: fatal error: DHT.h: No such file or directory'
			};
		}
		return {
			success: true,
			compilerOutput: 'Sketch uses 1450 bytes (4%) of program storage space. Maximum is 32256 bytes.\nGlobal variables use 150 bytes (7%) of dynamic memory.',
			builderResult: {
				usedRam: 150,
				totalRam: 2048,
				usedFlash: 1450,
				totalFlash: 32256
			}
		};
	}
	async upload(sketchPath: string, fqbn: string, port: string): Promise<UploadResult> {
		return { success: true, output: 'Done uploading.' };
	}
	async listDetectedBoards(): Promise<ArduinoDetectedBoard[]> { return []; }
	async searchLibraries(query: string): Promise<LibrarySearchResult[]> { return []; }
	async installLibrary(libName: string): Promise<{ success: boolean; message: string }> { return { success: true, message: 'Installed' }; }
	async searchCores(query: string): Promise<CoreSearchResult[]> { return []; }
	async installCore(coreName: string): Promise<{ success: boolean; message: string }> { return { success: true, message: 'Installed' }; }
}

describe('Arduino Tools Suite', () => {
	const mockCli = new MockArduinoCliService();
	const boardService = new BoardContextService();
	const sketchService = new SketchService();
	const serialService = new SerialTelemetryService();

	it('ArduinoCompileTool should format compilation success with RAM and Flash metrics', async () => {
		const compileTool = new ArduinoCompileTool(mockCli, boardService, sketchService);
		const result = await compileTool.execute({ sketchPath: '/path/to/mysketch' });

		expect(result.success).toBe(true);
		expect(result.summary).toContain('Compilation SUCCESS for Arduino Uno');
		expect(result.flashUsage).toContain('1450 bytes / 32256 bytes');
		expect(result.ramUsage).toContain('150 bytes / 2048 bytes');
	});

	it('ArduinoFixErrorsTool should parse compiler diagnostics and identify missing libraries', async () => {
		const fixErrorsTool = new ArduinoFixErrorsTool(mockCli, boardService, sketchService);
		const result = await fixErrorsTool.execute({
			errorLog: '/tmp/build/sketch.ino.cpp:12:10: fatal error: Adafruit_Sensor.h: No such file or directory\n/path/sketch.ino:15:2: error: expected \';\' before \'}\' token'
		});

		expect(result.hasErrors).toBe(true);
		expect(result.diagnostics.length).toBe(2);
		expect(result.diagnostics[0].isMissingLibrary).toBe(true);
		expect(result.diagnostics[0].suggestedLibrary).toBe('Adafruit_Sensor');
		expect(result.suggestedActions.length).toBeGreaterThan(0);
	});

	it('ArduinoPinoutTool should return board specs and validate pin capabilities', async () => {
		const pinoutTool = new ArduinoPinoutTool(boardService);
		const result = await pinoutTool.execute({ checkPin: 3, capability: 'pwm' });

		expect(result.board.name).toBe('Arduino Uno');
		expect(result.pinValidation?.supported).toBe(true);
		expect(result.summary).toContain('Operating Voltage: 5V');
	});

	it('ArduinoCircuitDiagramTool should generate wiring table and schematic for DHT sensor', async () => {
		const circuitTool = new ArduinoCircuitDiagramTool(boardService);
		const result = await circuitTool.execute({ componentName: 'DHT22' });

		expect(result.wiringTable.length).toBeGreaterThan(0);
		expect(result.safetyNotes.some(n => n.includes('pull-up'))).toBe(true);
		expect(result.mermaidDiagram).toContain('graph LR');
		expect(result.asciiDiagram).toContain('VCC');
	});

	it('ArduinoToolsRegistry should successfully dispatch tool calls', async () => {
		const registry = new ArduinoToolsRegistry(mockCli, boardService, sketchService, serialService);
		const defs = registry.getToolDefinitions();
		expect(defs.length).toBe(7);

		const pinoutRes = await registry.dispatch('arduino_pinout_checker', { checkPin: 9, capability: 'pwm' });
		expect(pinoutRes.board.name).toBe('Arduino Uno');
	});
});
