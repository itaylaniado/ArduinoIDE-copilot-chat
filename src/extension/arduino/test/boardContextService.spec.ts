/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { BoardContextService, KNOWN_BOARDS } from '../services/boardContextService';

describe('BoardContextService', () => {
	it('should return default profile for Arduino Uno', () => {
		const service = new BoardContextService();
		const board = service.getActiveBoard();
		expect(board.fqbn).toBe('arduino:avr:uno');
		expect(board.name).toBe('Arduino Uno');
		expect(board.voltage).toBe(5.0);
		expect(board.sramBytes).toBe(2048);
	});

	it('should accurately validate PWM pin capabilities on Arduino Uno', () => {
		const service = new BoardContextService();
		service.setActiveBoard('arduino:avr:uno');

		// Pins 3, 5, 6, 9, 10, 11 are PWM on Uno
		expect(service.validatePinCapability(3, 'pwm').supported).toBe(true);
		expect(service.validatePinCapability(9, 'pwm').supported).toBe(true);
		expect(service.validatePinCapability(4, 'pwm').supported).toBe(false);
		expect(service.validatePinCapability(4, 'pwm').warning).toContain('Pin 4 does NOT support PWM');
	});

	it('should validate analog input pins on Uno and ESP32', () => {
		const service = new BoardContextService();
		service.setActiveBoard('arduino:avr:uno');
		expect(service.validatePinCapability('A0', 'analog').supported).toBe(true);
		expect(service.validatePinCapability('D2', 'analog').supported).toBe(false);

		service.setActiveBoard('esp32:esp32:esp32');
		expect(service.getActiveBoard().voltage).toBe(3.3);
		expect(service.getActiveBoard().architecture).toBe('xtensa-esp32');
	});

	it('should validate I2C and SPI pins', () => {
		const service = new BoardContextService();
		service.setActiveBoard('arduino:avr:uno');

		expect(service.validatePinCapability('A4', 'i2c').supported).toBe(true);
		expect(service.validatePinCapability('A5', 'i2c').supported).toBe(true);
		expect(service.validatePinCapability(2, 'i2c').supported).toBe(false);

		expect(service.validatePinCapability(11, 'spi').supported).toBe(true);
		expect(service.validatePinCapability(13, 'spi').supported).toBe(true);
	});
});
