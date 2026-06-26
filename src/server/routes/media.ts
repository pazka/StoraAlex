import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import fs from 'node:fs';
import path from 'node:path';
import { S } from '../schemas.js';
import { processAndStore, ImageError } from '../lib/images.js';

export const mediaRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const { repos, appConfig } = app;

  app.post('/api/media', async (req, reply) => {
    let data;
    try {
      data = await req.file();
    } catch {
      return reply.code(400).send({ error: 'invalid multipart upload' });
    }
    if (!data) return reply.code(400).send({ error: 'no file provided' });

    let buf: Buffer;
    try {
      buf = await data.toBuffer();
    } catch {
      // Thrown when the file exceeds the configured size limit.
      return reply.code(413).send({ error: 'file too large' });
    }

    try {
      const stored = await processAndStore(buf, appConfig.mediaDir);
      const id = repos.photos.create(stored.path, stored.width, stored.height, stored.bytes);
      reply.code(201);
      return { photo_id: id, width: stored.width, height: stored.height };
    } catch (err) {
      if (err instanceof ImageError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.get('/media/:id', { schema: S.media }, async (req, reply) => {
    const photo = repos.photos.find(req.params.id);
    if (!photo) return reply.code(404).send({ error: 'photo not found' });

    const mediaRoot = path.resolve(appConfig.mediaDir);
    const resolved = path.resolve(mediaRoot, photo.path);
    if (resolved !== mediaRoot && !resolved.startsWith(mediaRoot + path.sep)) {
      return reply.code(400).send({ error: 'bad path' });
    }
    if (!fs.existsSync(resolved)) return reply.code(404).send({ error: 'file missing' });

    return reply
      .type('image/webp')
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(fs.createReadStream(resolved));
  });
};
