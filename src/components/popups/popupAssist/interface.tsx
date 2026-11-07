import BookModel from "../../../models/Book";

export interface AiChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface PopupAssistProps {
  chapterDocIndex?: number;
  chapter?: string;
  isDockedRight?: boolean;
  currentBook: BookModel;
  originalText: string;
  quoteText: string;
  htmlBook: any;
  handleOpenMenu: (isOpenMenu: boolean) => void;
  handleMenuMode: (menu: string) => void;
  handleQuoteText: (quoteText: string) => void;
}

export type AssistantMode = "ask" | "chat";
