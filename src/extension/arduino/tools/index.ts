/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { IArduinoCliService } from '../services/arduinoCliService';
import { IBoardContextService } from '../services/boardContextService';
import { ISketchService } from '../services/sketchService';
import { ISerialTelemetryService } from '../services/serialTelemetryService';

import { ArduinoCompileTool } from './arduinoCompileTool';
import { ArduinoFixErrorsTool } from './arduinoFixErrorsTool';
import { ArduinoUploadTool } from './arduinoUploadTool';
import { ArduinoLibraryTool } from './arduinoLibraryTool';
import { ArduinoPinoutTool } from './arduinoPinoutTool';
import { ArduinoCrashDecodeTool } from './arduinoCrashDecodeTool';
import { ArduinoCircuitDiagramTool } from './arduinoCircuitDiagramTool';

export interface ArduinoToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, any>;
}

export class ArduinoToolsRegistry {
	public readonly compileTool: ArduinoCompileTool;
	public readonly fixErrorsTool: ArduinoFixErrorsTool;
	public readonly uploadTool: ArduinoUploadTool;
	public readonly libraryTool: ArduinoLibraryTool;
	public readonly pinoutTool: ArduinoPinoutTool;
	public readonly crashDecodeTool: ArduinoCrashDecodeTool;
	public readonly circuitDiagramTool: ArduinoCircuitDiagramTool;

	constructor(
		arduinoCliService: IArduinoCliService,
		boardContextService: IBoardContextService,
		sketchService: ISketchService,
		serialTelemetryService: ISerialTelemetryService
	) {
		this.compileTool = new ArduinoCompileTool(arduinoCliService, boardContextService, sketchService);
		this.fixErrorsTool = new ArduinoFixErrorsTool(arduinoCliService, boardContextService, sketchService);
		this.uploadTool = new ArduinoUploadTool(arduinoCliService, boardContextService, sketchService);
		this.libraryTool = new ArduinoLibraryTool(arduinoCliService);
		this.pinoutTool = new ArduinoPinoutTool(boardContextService);
		this.crashDecodeTool = new ArduinoCrashDecodeTool(serialTelemetryService, sketchService);
		this.circuitDiagramTool = new ArduinoCircuitDiagramTool(boardContextService);
	}

	public getToolDefinitions(): ArduinoToolDefinition[] {
		return [
			{
				name: ArduinoCompileTool.toolName,
				description: ArduinoCompileTool.description,
				parameters: {
					type: 'object',
					properties: {
						sketchPath: { type: 'string', description: 'Path to sketch folder (defaults to active sketch)' },
						fqbn: { type: 'string', description: 'Target board FQBN (e.g. arduino:avr:uno)' }
					}
				}
			},
			{
				name: ArduinoFixErrorsTool.toolName,
				description: ArduinoFixErrorsTool.description,
				parameters: {
					type: 'object',
					properties: {
						errorLog: { type: 'string', description: 'Compiler error output (optional, compiles sketch if omitted)' }
					}
				}
			},
			{
				name: ArduinoUploadTool.toolName,
				description: ArduinoUploadTool.description,
				parameters: {
					type: 'object',
					properties: {
						sketchPath: { type: 'string', description: 'Path to sketch folder' },
						fqbn: { type: 'string', description: 'Target board FQBN' },
						port: { type: 'string', description: 'Serial port (e.g. COM3 or /dev/cu.usbmodem...)' }
					}
				}
			},
			{
				name: ArduinoLibraryTool.toolName,
				description: ArduinoLibraryTool.description,
				parameters: {
					type: 'object',
					properties: {
						action: { type: 'string', enum: ['search', 'install'], description: 'Whether to search or install' },
						libraryName: { type: 'string', description: 'Name of the library' }
					},
					required: ['action', 'libraryName']
				}
			},
			{
				name: ArduinoPinoutTool.toolName,
				description: ArduinoPinoutTool.description,
				parameters: {
					type: 'object',
					properties: {
						fqbn: { type: 'string', description: 'Board FQBN (optional)' },
						checkPin: { type: ['string', 'number'], description: 'Pin to check' },
						capability: { type: 'string', enum: ['pwm', 'analog', 'interrupt', 'i2c', 'spi'], description: 'Capability to validate' }
					}
				}
			},
			{
				name: ArduinoCrashDecodeTool.toolName,
				description: ArduinoCrashDecodeTool.description,
				parameters: {
					type: 'object',
					properties: {
						serialSnippet: { type: 'string', description: 'Crash or serial log text' }
					},
					required: ['serialSnippet']
				}
			},
			{
				name: ArduinoCircuitDiagramTool.toolName,
				description: ArduinoCircuitDiagramTool.description,
				parameters: {
					type: 'object',
					properties: {
						componentName: { type: 'string', description: 'Sensor, actuator, or component name' },
						fqbn: { type: 'string', description: 'Board FQBN (optional)' }
					},
					required: ['componentName']
				}
			}
		];
	}

	public async dispatch(name: string, params: any): Promise<any> {
		switch (name) {
			case ArduinoCompileTool.toolName:
				return await this.compileTool.execute(params);
			case ArduinoFixErrorsTool.toolName:
				return await this.fixErrorsTool.execute(params);
			case ArduinoUploadTool.toolName:
				return await this.uploadTool.execute(params);
			case ArduinoLibraryTool.toolName:
				return await this.libraryTool.execute(params);
			case ArduinoPinoutTool.toolName:
				return await this.pinoutTool.execute(params);
			case ArduinoCrashDecodeTool.toolName:
				return await this.crashDecodeTool.execute(params);
			case ArduinoCircuitDiagramTool.toolName:
				return await this.circuitDiagramTool.execute(params);
			default:
				throw new Error(`Unknown Arduino tool: ${name}`);
		}
	}
}
