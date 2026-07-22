import { randomUUID } from 'node:crypto';
import type { RetrievalTrace } from '../retrieval/trace';
import type { ServingObservationConfig } from './config';
import {
  isLocalSinkErrorCode,
  type LocalObservationSink,
  type LocalSinkErrorCode,
} from './local-sink';
import {
  ServingRedactionError,
  redactServingQuestion,
  type RedactedServingQuestion,
  type ServingQuestionRedactionOptions,
  type ServingRedactionErrorCode,
} from './redaction';
import { shouldSample } from './sampling';
import {
  decodeServingRetrievalObservation,
  projectServingRetrievalObservation,
  type ServingRetrievalObservation,
} from './serving-observation';

type LocalServingObservationConfig = Extract<
  ServingObservationConfig,
  { mode: 'local' }
>;

export interface ServingObservationRecorderDependencies {
  clock?: () => Date;
  idFactory?: () => string;
  sampler?: (requestId: string, sampleRate: number) => boolean;
  redactor?: (
    question: string,
    options: ServingQuestionRedactionOptions,
  ) => RedactedServingQuestion;
  projector?: typeof projectServingRetrievalObservation;
  decoder?: (value: unknown) => ServingRetrievalObservation;
  sink?: LocalObservationSink;
}

export type ServingObservationRecordResult =
  | { status: 'disabled' }
  | { status: 'sampled_out' }
  | { status: 'written' }
  | { status: 'sampling_failed'; errorCode: 'sampling_internal' }
  | {
      status: 'redaction_failed';
      errorCode: ServingRedactionErrorCode;
    }
  | { status: 'projection_failed'; errorCode: 'projection_internal' }
  | {
      status: 'write_failed';
      errorCode: LocalSinkErrorCode | 'sink_internal' | 'sink_unavailable';
    };

export interface ServingObservationRecorder {
  record(
    requestId: string,
    trace: RetrievalTrace,
  ): ServingObservationRecordResult;
  traceSink(
    requestId: string,
    onResult?: (result: ServingObservationRecordResult) => void,
  ): (trace: RetrievalTrace) => void;
}

class SynchronousServingObservationRecorder
  implements ServingObservationRecorder
{
  private readonly config: ServingObservationConfig;
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly sampler: (requestId: string, sampleRate: number) => boolean;
  private readonly redactor: (
    question: string,
    options: ServingQuestionRedactionOptions,
  ) => RedactedServingQuestion;
  private readonly projector: typeof projectServingRetrievalObservation;
  private readonly decoder: (
    value: unknown,
  ) => ServingRetrievalObservation;
  private readonly sink: LocalObservationSink | undefined;

  constructor(
    config: ServingObservationConfig,
    dependencies: ServingObservationRecorderDependencies,
  ) {
    this.config = config;
    this.clock = dependencies.clock ?? (() => new Date());
    this.idFactory = dependencies.idFactory ?? randomUUID;
    this.sampler = dependencies.sampler ?? shouldSample;
    this.redactor = dependencies.redactor ?? redactServingQuestion;
    this.projector =
      dependencies.projector ?? projectServingRetrievalObservation;
    this.decoder = dependencies.decoder ?? decodeServingRetrievalObservation;
    this.sink = dependencies.sink;
  }

  record(
    requestId: string,
    trace: RetrievalTrace,
  ): ServingObservationRecordResult {
    try {
      return this.recordInternal(requestId, trace);
    } catch {
      return {
        status: 'projection_failed',
        errorCode: 'projection_internal',
      };
    }
  }

  traceSink(
    requestId: string,
    onResult?: (result: ServingObservationRecordResult) => void,
  ): (trace: RetrievalTrace) => void {
    return (trace) => {
      try {
        const result = this.record(requestId, trace);
        try {
          onResult?.(result);
        } catch {
          // Diagnostic reporting is outside the retrieval success boundary.
        }
      } catch {
        // The pipeline contract is fail-open even if a future recorder change regresses.
      }
    };
  }

  private recordInternal(
    requestId: string,
    trace: RetrievalTrace,
  ): ServingObservationRecordResult {
    if (this.config.mode === 'off') return { status: 'disabled' };
    const config: LocalServingObservationConfig = this.config;

    let sampled: boolean;
    try {
      sampled = this.sampler(requestId, config.sampleRate);
    } catch {
      return {
        status: 'sampling_failed',
        errorCode: 'sampling_internal',
      };
    }
    if (!sampled) return { status: 'sampled_out' };

    let redactedQuestion: RedactedServingQuestion;
    try {
      redactedQuestion = this.redactor(trace.question, {
        maxInputBytes: config.maxInputBytes,
        maxTextBytes: config.maxTextBytes,
      });
    } catch (error) {
      return {
        status: 'redaction_failed',
        errorCode:
          error instanceof ServingRedactionError
            ? error.code
            : 'redaction_internal',
      };
    }

    let observation: ServingRetrievalObservation;
    try {
      const now = this.clock();
      const createdAt = now.toISOString();
      const candidate = this.projector({
        requestId,
        observationId: this.idFactory(),
        trace: { ...trace, createdAt },
        redactedQuestion,
      });
      observation = this.decoder(candidate);
    } catch {
      return {
        status: 'projection_failed',
        errorCode: 'projection_internal',
      };
    }

    if (this.sink === undefined) {
      return { status: 'write_failed', errorCode: 'sink_unavailable' };
    }
    try {
      const result = this.sink.append(observation);
      if (result.ok) return { status: 'written' };
      return {
        status: 'write_failed',
        errorCode: isLocalSinkErrorCode(result.error.code)
          ? result.error.code
          : 'sink_internal',
      };
    } catch {
      return { status: 'write_failed', errorCode: 'sink_internal' };
    }
  }
}

export function createServingObservationRecorder(
  config: ServingObservationConfig,
  dependencies: ServingObservationRecorderDependencies = {},
): ServingObservationRecorder {
  return new SynchronousServingObservationRecorder(config, dependencies);
}
