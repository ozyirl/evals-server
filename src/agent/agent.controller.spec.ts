import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { ImageAgentService } from './image-agent.service';
import { AssessmentLogService } from '../assessments/assessment-log.service';
import { PipelineLogService } from '../assessments/pipeline-log.service';

describe('image API contract', () => {
  let app: INestApplication;
  let token: string;
  const runId = randomUUID();
  const imageAgent = { assessImage: jest.fn() };
  const pipelineLog = { listForRun: jest.fn() };
  const previousKey = process.env.CLERK_PEM_PUBLIC_KEY;
  const previousIssuer = process.env.CLERK_ISSUER;

  beforeAll(async () => {
    // Isolated test keys exercise the real guard; no running-server auth settings change.
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    process.env.CLERK_PEM_PUBLIC_KEY = publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();
    process.env.CLERK_ISSUER = 'https://clerk.example.test';
    token = jwt.sign({ sub: 'api-test-user' }, privateKey, {
      algorithm: 'RS256',
      issuer: process.env.CLERK_ISSUER,
      expiresIn: '5m',
    });
    const module = await Test.createTestingModule({
      controllers: [AgentController],
      providers: [
        { provide: AgentService, useValue: {} },
        { provide: ImageAgentService, useValue: imageAgent },
        { provide: AssessmentLogService, useValue: { listForUser: jest.fn() } },
        { provide: PipelineLogService, useValue: pipelineLog },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (previousKey === undefined) delete process.env.CLERK_PEM_PUBLIC_KEY;
    else process.env.CLERK_PEM_PUBLIC_KEY = previousKey;
    if (previousIssuer === undefined) delete process.env.CLERK_ISSUER;
    else process.env.CLERK_ISSUER = previousIssuer;
  });
  beforeEach(() => jest.clearAllMocks());

  it('returns the run ID and structured prompt while using the authenticated identity', async () => {
    const result = {
      runId,
      destination: 'enhance',
      enhancementPrompt: { prompt: 'Lift shadows.' },
    };
    imageAgent.assessImage.mockResolvedValue(result);
    const response = await request(app.getHttpServer())
      .post('/agent/assess-image')
      .set('Authorization', `Bearer ${token}`)
      .send({
        imageUrl: 'https://example.com/food.png',
        userId: 'spoofed-user',
      })
      .expect(201);
    expect(response.body).toEqual(result);
    expect(imageAgent.assessImage).toHaveBeenCalledWith(
      { imageUrl: 'https://example.com/food.png' },
      { userId: 'api-test-user' },
    );
  });

  it('requires authentication to read hop events', async () => {
    await request(app.getHttpServer())
      .get(`/agent/assessments/${runId}/events`)
      .expect(401);
    expect(pipelineLog.listForRun).not.toHaveBeenCalled();
  });

  it('passes both the authenticated user and run ID to event retrieval', async () => {
    pipelineLog.listForRun.mockResolvedValue([]);
    await request(app.getHttpServer())
      .get(`/agent/assessments/${runId}/events`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200, []);
    expect(pipelineLog.listForRun).toHaveBeenCalledWith('api-test-user', runId);
  });

  it('rejects malformed run IDs before querying the database', async () => {
    await request(app.getHttpServer())
      .get('/agent/assessments/not-a-uuid/events')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
    expect(pipelineLog.listForRun).not.toHaveBeenCalled();
  });
});
