import { connect } from "react-redux";
import { withTranslation } from "react-i18next";
import { handleQuoteText } from "../../../store/actions";
import { stateType } from "../../../store";
import PopupAssist from "./component";

const mapStateToProps = (state: stateType) => {
  return {
    currentBook: state.book.currentBook,
    originalText: state.reader.originalText,
    quoteText: state.reader.quoteText,
    htmlBook: state.reader.htmlBook,
  };
};

const actionCreator = {
  handleQuoteText,
};

export default connect(
  mapStateToProps,
  actionCreator
)(withTranslation()(PopupAssist as any) as any);
