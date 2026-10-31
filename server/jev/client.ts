import { TypeSafeClient } from '@typesafe-ai/sdk';
import type { Dest, Email, Folder, JevAnswers, NoulId } from '../../shared/types';
import { NOUL_IDS } from '../../shared/types';
import { buildQuestions, buildState } from './questions';

export interface JevClient {
  ask(email: Email, folders: Folder[]): Promise<JevAnswers>;
}

/** The slice of the SDK client that TypeSafeJev uses; tests inject a stand-in. */
export interface SystemOneLike {
  systemOne(request: { state: Record<string, unknown>; questions: any; model?: string }): PromiseLike<{ answers: Record<string, any> }>;
}

export class TypeSafeJev implements JevClient {
  private readonly sdk: SystemOneLike;
  constructor(apiKey: string, private readonly model: string, sdk?: SystemOneLike) {
    // The SDK retries 408/429/5xx twice by default.
    this.sdk = sdk ?? (new TypeSafeClient({ apiKey }) as unknown as SystemOneLike);
  }

  async ask(email: Email, folders: Folder[]): Promise<JevAnswers> {
    const { questions, keyToDest } = buildQuestions(folders);
    const { answers } = await this.sdk.systemOne({ state: buildState(email, folders, new Date()), questions, model: this.model });

    const d = answers.destination;
    const choice = keyToDest[d.choice];
    if (!choice) throw new Error(`Jev returned unknown destination option "${d.choice}"`);
    const probabilities: Partial<Record<Dest, number>> = {};
    for (const [key, dest] of Object.entries(keyToDest)) {
      const p = d.probabilities?.[key];
      if (typeof p === 'number') probabilities[dest] = p;
    }
    const nouls = {} as Record<NoulId, number>;
    for (const id of NOUL_IDS) {
      const v = answers[id]?.noul;
      if (typeof v !== 'number') throw new Error(`Jev response is missing noul "${id}"`);
      nouls[id] = v;
    }
    return { destination: { choice, confidence: d.confidence, probabilities }, nouls };
  }
}

export class FakeJev implements JevClient {
  constructor(private readonly answersByThread: Record<string, JevAnswers>) {}
  async ask(email: Email, _folders?: Folder[]): Promise<JevAnswers> {
    const a = this.answersByThread[email.threadId];
    if (!a) throw new Error(`FakeJev has no answers for thread ${email.threadId}`);
    return a;
  }
}
