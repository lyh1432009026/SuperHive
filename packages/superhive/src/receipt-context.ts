import type { ChatMessage } from "./hive-protocol.js";

export type ReceiptResult = { receiptId: string; messageId: string; result?: ChatMessage };

export async function loadReceiptResults(
  triggers: ChatMessage[],
  messages: ChatMessage[],
  fetchMessage: (seq: number, id: string) => Promise<ChatMessage | undefined>,
): Promise<ReceiptResult[]> {
  return Promise.all(
    triggers.flatMap((receipt) => {
      if (receipt.kind !== "receipt" || receipt.text?.key !== "receipt.compact") return [];
      const params = receipt.text.params;
      const seq = params?.seq;
      const messageId = params?.resultMessageId;
      if (
        typeof seq !== "number" ||
        !Number.isSafeInteger(seq) ||
        seq <= 0 ||
        seq >= receipt.seq ||
        typeof messageId !== "string" ||
        !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(messageId)
      )
        return [];
      return [
        (async () => {
          const current = messages.find((message) => message.id === messageId);
          const result = current ?? (await fetchMessage(seq, messageId).catch(() => undefined));
          const valid =
            result &&
            !result.deletedAt &&
            result.id === messageId &&
            result.seq === seq &&
            result.roomId === receipt.roomId &&
            result.senderId === receipt.senderId;
          return { receiptId: receipt.id, messageId, ...(valid ? { result } : {}) };
        })(),
      ];
    }),
  );
}
