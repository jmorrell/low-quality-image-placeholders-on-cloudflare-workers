class PNGFilterStream extends TransformStream {
	constructor(width: number, height: number) {
		const bytesPerPixel = 3; // RGB
		const scanlineLength = width * bytesPerPixel;
		const totalBytes = height * (scanlineLength + 1); // +1 for filter byte per row

		let buffer = new Uint8Array();
		let processedRows = 0;
		let previousRow = new Uint8Array(scanlineLength);
		const outputData = new Uint8Array(height * scanlineLength);

		super({
			transform(chunk, controller) {
				// Accumulate chunks into buffer
				const newBuffer = new Uint8Array(buffer.length + chunk.length);
				newBuffer.set(buffer);
				newBuffer.set(chunk, buffer.length);
				buffer = newBuffer;

				// Process complete scanlines
				while (buffer.length >= scanlineLength + 1 && processedRows < height) {
					const filterType = buffer[0];
					const filteredRow = buffer.slice(1, scanlineLength + 1);
					const unfilteredRow = new Uint8Array(scanlineLength);

					// Apply PNG filter reversal
					switch (filterType) {
						case 0: // None
							unfilteredRow.set(filteredRow);
							break;

						case 1: // Sub
							for (let i = 0; i < scanlineLength; i++) {
								const left = i >= bytesPerPixel ? unfilteredRow[i - bytesPerPixel] : 0;
								unfilteredRow[i] = (filteredRow[i] + left) & 0xff;
							}
							break;

						case 2: // Up
							for (let i = 0; i < scanlineLength; i++) {
								const up = previousRow[i];
								unfilteredRow[i] = (filteredRow[i] + up) & 0xff;
							}
							break;

						case 3: // Average
							for (let i = 0; i < scanlineLength; i++) {
								const left = i >= bytesPerPixel ? unfilteredRow[i - bytesPerPixel] : 0;
								const up = previousRow[i];
								const average = Math.floor((left + up) / 2);
								unfilteredRow[i] = (filteredRow[i] + average) & 0xff;
							}
							break;

						case 4: // Paeth
							for (let i = 0; i < scanlineLength; i++) {
								const left = i >= bytesPerPixel ? unfilteredRow[i - bytesPerPixel] : 0;
								const up = previousRow[i];
								const upperLeft = i >= bytesPerPixel ? previousRow[i - bytesPerPixel] : 0;

								const p = left + up - upperLeft;
								const pa = Math.abs(p - left);
								const pb = Math.abs(p - up);
								const pc = Math.abs(p - upperLeft);

								let predictor;
								if (pa <= pb && pa <= pc) {
									predictor = left;
								} else if (pb <= pc) {
									predictor = up;
								} else {
									predictor = upperLeft;
								}

								unfilteredRow[i] = (filteredRow[i] + predictor) & 0xff;
							}
							break;

						default:
							throw new Error(`Unknown filter type: ${filterType}`);
					}

					outputData.set(unfilteredRow, processedRows * scanlineLength);
					previousRow = new Uint8Array(unfilteredRow);
					processedRows++;
					buffer = buffer.slice(scanlineLength + 1);
				}
			},

			flush(controller) {
				controller.enqueue(outputData);
			},
		});
	}
}

export async function parsePNG(buffer: Uint8Array) {
	// All PNGs start with the same signature: 89 50 4E 47 0D 0A 1A 0A
	// If we don't find this signature, fail fast
	const expectedSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	for (let i = 0; i < 8; i++) {
		if (buffer[i] !== expectedSignature[i]) {
			throw new Error('Invalid PNG signature');
		}
	}

	let offset = 8,
		width = 0,
		height = 0,
		bitDepth = 0,
		colorType = 0;

	// First pass: get dimensions and color info
	while (offset < buffer.length) {
		const length = new DataView(buffer.buffer, offset, 4).getUint32(0);
		const type = new TextDecoder().decode(buffer.slice(offset + 4, offset + 8));

		if (type === 'IHDR') {
			const data = buffer.slice(offset + 8, offset + 8 + length);
			const view = new DataView(data.buffer, data.byteOffset);
			width = view.getUint32(0);
			height = view.getUint32(4);
			bitDepth = view.getUint8(8);
			colorType = view.getUint8(9);

			if (bitDepth !== 8 || colorType !== 2) {
				throw new Error('Unsupported PNG format. This code only supports 8-bit RGB PNG images.');
			}

			break;
		}

		offset += 12 + length;
	}

	// Second pass: decompress and filter
	offset = 8;
	const decompressor = new DecompressionStream('deflate');
	const filterProcessor = new PNGFilterStream(width, height);

	// Pipe decompression into filter processing
	const readable = decompressor.readable.pipeThrough(filterProcessor);
	const writer = decompressor.writable.getWriter();

	// Write IDAT chunks to decompressor
	while (offset < buffer.length) {
		const length = new DataView(buffer.buffer, offset, 4).getUint32(0);
		const type = new TextDecoder().decode(buffer.slice(offset + 4, offset + 8));
		const data = buffer.slice(offset + 8, offset + 8 + length);

		if (type === 'IDAT') {
			await writer.write(data);
		} else if (type === 'IEND') {
			await writer.close();
			break;
		}

		offset += 12 + length;
	}

	// Read the filtered result
	const reader = readable.getReader();
	const result = await reader.read();
	const rawImageData = result.value;

	return {
		width,
		height,
		bitDepth,
		colorType,
		rawImageData: rawImageData ? Array.from(rawImageData) : null,
		length: rawImageData ? rawImageData.length : 0,
		numRGBPixels: width * height * 3,
	};
}
