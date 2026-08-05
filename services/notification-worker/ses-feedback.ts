import {
  parseSesFeedbackEvent,
  SesFeedbackValidationError,
  type SesFeedbackEvent,
} from "../../lib/ses-feedback.ts";

export interface SesFeedbackQueueMessage {
  readonly receiptHandle: string;
  readonly body: string;
}

export interface SesFeedbackQueue {
  receive(signal?: AbortSignal): Promise<SesFeedbackQueueMessage | null>;
  delete(receiptHandle: string): Promise<void>;
}

export interface SesFeedbackRepository {
  reconcileSesFeedback(
    event: SesFeedbackEvent,
  ): Promise<"applied" | "duplicate" | "unmatched">;
}

export type SesFeedbackProcessingResult =
  | "idle"
  | "ses_feedback_applied"
  | "ses_feedback_duplicate"
  | "ses_feedback_invalid"
  | "ses_feedback_unmatched";

export async function processOneSesFeedback(input: {
  readonly queue: SesFeedbackQueue;
  readonly repository: SesFeedbackRepository;
  readonly expectedRegion: string;
  readonly expectedAccountId: string;
  readonly expectedConfigurationSetName: string;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}): Promise<SesFeedbackProcessingResult> {
  const message = await input.queue.receive(input.signal);
  if (message === null) return "idle";
  let event: SesFeedbackEvent;
  try {
    event = await parseSesFeedbackEvent({
      body: message.body,
      expectedRegion: input.expectedRegion,
      expectedAccountId: input.expectedAccountId,
      expectedConfigurationSetName: input.expectedConfigurationSetName,
      now: (input.now ?? Date.now)(),
    });
  } catch (error) {
    if (error instanceof SesFeedbackValidationError) return "ses_feedback_invalid";
    throw error;
  }
  const result = await input.repository.reconcileSesFeedback(event);
  if (result === "unmatched") return "ses_feedback_unmatched";
  await input.queue.delete(message.receiptHandle);
  return result === "applied"
    ? "ses_feedback_applied"
    : "ses_feedback_duplicate";
}
