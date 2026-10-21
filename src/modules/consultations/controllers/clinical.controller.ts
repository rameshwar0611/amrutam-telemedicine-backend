import type { Request, Response } from 'express';
import { actor, context } from '../../identity/controllers/identity.controller.js';
import { sendResult, requestKey } from '../../../shared/http-result.js';
import { clinicalParams, notesWriteSchema, transitionSchema } from '../schemas.js';
import type { ClinicalService } from '../services/clinical.service.js';
export class ClinicalController {
  constructor(private readonly clinical: ClinicalService) {}
  async read(request: Request, response: Response) {
    sendResult(
      response,
      await this.clinical.read(
        actor(response),
        clinicalParams.parse(request.params).consultationId,
        context(response),
      ),
    );
  }
  async notes(request: Request, response: Response) {
    sendResult(
      response,
      await this.clinical.read(
        actor(response),
        clinicalParams.parse(request.params).consultationId,
        context(response),
        true,
      ),
    );
  }
  async writeNotes(request: Request, response: Response) {
    sendResult(
      response,
      await this.clinical.writeNotes(
        actor(response),
        clinicalParams.parse(request.params).consultationId,
        notesWriteSchema.parse(request.body),
        requestKey(request),
        context(response),
      ),
    );
  }
  async transition(request: Request, response: Response) {
    sendResult(
      response,
      await this.clinical.transition(
        actor(response),
        clinicalParams.parse(request.params).consultationId,
        transitionSchema.parse(request.body).status,
        requestKey(request),
        context(response),
      ),
    );
  }
}
