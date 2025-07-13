function parsePNG(buffer: Uint8Array) {
	// Check PNG signature: 89 50 4E 47 0D 0A 1A 0A
	const expectedSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
	for (let i = 0; i < 8; i++) {
		if (buffer[i] !== expectedSignature[i]) {
			throw new Error('Invalid PNG signature');
		}
	}
	
	let offset = 8;
	let imageData: Uint8Array | null = null;
	let width = 0,
		height = 0;

	while (offset < buffer.length) {
		const length = new DataView(buffer.buffer, offset, 4).getUint32(0);
		const type = new TextDecoder().decode(buffer.slice(offset + 4, offset + 8));
		const data = buffer.slice(offset + 8, offset + 8 + length);

		if (type === 'IHDR') {
			const view = new DataView(data.buffer, data.byteOffset);
			width = view.getUint32(0);
			height = view.getUint32(4);
		} else if (type === 'IDAT') {
			if (!imageData) {
				imageData = new Uint8Array(data);
			} else {
				const combined = new Uint8Array(imageData.length + data.length);
				combined.set(imageData);
				combined.set(data, imageData.length);
				imageData = combined;
			}
		}

		offset += 12 + length;
		if (type === 'IEND') break;
	}

	return {
		width,
		height,
		rawImageData: imageData ? Array.from(imageData) : null,
	};
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const imageUrl = url.searchParams.get('url');
		const output = url.searchParams.get('output') || 'json';

		if (!imageUrl) {
			return new Response('Missing url query parameter', { status: 400 });
		}

		try {
			const imageResponse = await fetch(imageUrl);
			if (!imageResponse.ok) {
				return new Response('Failed to fetch image', { status: 400 });
			}

			const resizedImage = await env.IMAGES.input(imageResponse.body!)
				.transform({ width: 30, height: 30, fit: 'cover' })
				.output({ format: 'image/png' });

			if (output === 'image') {
				return resizedImage.response();
			}

			const pngBuffer = await resizedImage.response().arrayBuffer();
			const pngData = parsePNG(new Uint8Array(pngBuffer));

			return new Response(JSON.stringify(pngData, null, 2), {
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error) {
			return new Response('Error processing image', { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
