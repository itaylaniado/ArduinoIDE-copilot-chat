/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { IArduinoCliService } from '../services/arduinoCliService';
import { IBoardContextService } from '../services/boardContextService';
import { ISketchService } from '../services/sketchService';

export interface UploadParams {
	sketchPath?: string;
	fqbn?: string;
	port?: string;
}

export interface UploadToolOutput {
	success: boolean;
	summary: string;
	troubleshootingTips?: string[];
	rawOutput: string;
}

export class ArduinoUploadTool {
	public static readonly toolName = 'arduino_upload';
	public static readonly description = 'Upload the compiled Arduino sketch to the connected microcontroller board and diagnose upload errors.';

	constructor(
		private readonly arduinoCliService: IArduinoCliService,
		private readonly boardContextService: IBoardContextService,
		private readonly sketchService: ISketchService
	) {}

	public async execute(params: UploadParams): Promise<UploadToolOutput> {
		const targetFqbn = params.fqbn || this.boardContextService.getActiveBoard().fqbn;
		const targetPort = params.port || this.boardContextService.getActivePort();
		const targetSketch = params.sketchPath || this.sketchService.getActiveSketchFolder();

		if (!targetSketch) {
			return {
				success: false,
				summary: 'No active Arduino sketch folder found to upload.',
				rawOutput: ''
			};
		}

		if (!targetPort) {
			// Attempt to auto-detect board port
			const detected = await this.arduinoCliService.listDetectedBoards();
			if (detected.length === 0) {
				return {
					success: false,
					summary: 'No serial port specified and no connected Arduino boards detected.',
					troubleshootingTips: [
						'Connect your Arduino board via a data-capable USB cable.',
						'Ensure USB-to-UART drivers (CH340, CP2102, FTDI) are installed if using clone boards.',
						'Select the correct port from the Arduino IDE port dropdown or configure in settings.'
					],
					rawOutput: ''
				};
			}
			// Use the first detected port
			const firstPort = detected[0].port.address;
			this.boardContextService.setActivePort(firstPort);
			return this.performUpload(targetSketch, targetFqbn, firstPort);
		}

		return this.performUpload(targetSketch, targetFqbn, targetPort);
	}

	private async performUpload(sketch: string, fqbn: string, port: string): Promise<UploadToolOutput> {
		const res = await this.arduinoCliService.upload(sketch, fqbn, port);
		if (res.success) {
			return {
				success: true,
				summary: `Successfully uploaded sketch to ${fqbn} on port ${port}.`,
				rawOutput: res.output
			};
		}

		const tips: string[] = [];
		const err = (res.error || '') + '\n' + res.output;

		if (err.includes("can't open device") || err.includes('Access is denied') || err.includes('busy')) {
			tips.push('The serial port is currently busy. Close the Serial Monitor or Serial Plotter and try again.');
			tips.push('On Linux, check user permissions: ensure your user is added to the `dialout` or `uucp` group.');
		} else if (err.includes('stk500_recv') || err.includes('programmer is not responding')) {
			tips.push('AVR programmer sync failed. Press the reset button on your Arduino right as compilation completes and uploading begins.');
			tips.push('Verify that you selected the correct processor (e.g. ATmega328P vs ATmega328P Old Bootloader).');
		} else if (err.includes('Timed out waiting for packet header') || err.includes('A fatal error occurred: Failed to connect')) {
			tips.push('ESP32 / ESP8266 bootloader timeout: Press and hold the BOOT button on the ESP32 while "Connecting..." appears in the log.');
			tips.push('Place a 10uF electrolytic capacitor between the EN and GND pins to automate entering bootloader mode.');
		} else if (err.includes('No such file or directory') || err.includes('Port not found')) {
			tips.push(`Port '${port}' was not found. The board may have reset into a different port or disconnected.`);
		}

		return {
			success: false,
			summary: `Upload failed for ${fqbn} on port ${port}.`,
			troubleshootingTips: tips.length > 0 ? tips : ['Double check USB cable connection and board FQBN configuration.'],
			rawOutput: res.error || res.output
		};
	}
}
