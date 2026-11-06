import React from "react";
import "./popupTrans.css";
import { PopupTransProps, PopupTransState } from "./interface";
import { ConfigService } from "../../../assets/lib/kookit-extra-browser.min";
import axios from "axios";
import { Trans } from "react-i18next";
import toast from "react-hot-toast";
import { getDefaultTransTarget, openExternalUrl } from "../../../utils/common";
import { getIframeDoc } from "../../../utils/reader/docUtil";
import { getBuiltinTranslation } from "../../../utils/plugins/rendererRegistry";
import type { PluginConfig } from "../../../utils/plugins/types";
import {
  executeCustomTranslation,
  isCustomRendererPlugin,
} from "../../../utils/plugins/customPlugin";
class PopupTrans extends React.Component<PopupTransProps, PopupTransState> {
  constructor(props: PopupTransProps) {
    super(props);
    this.state = {
      translatedText: this.props.t("Model is starting, please wait..."),
      originalText: "",
      transService: ConfigService.getReaderConfig("transService") || "",
      transTarget: ConfigService.getReaderConfig("transTarget"),
      transSource: ConfigService.getReaderConfig("transSource"),
      isAddNew: false,
      isFinishOutput: false,
    };
  }

  async componentDidMount() {
    let originalText = this.props.originalText.replace(/(\r\n|\n|\r)/gm, "");
    this.setState({ originalText: originalText });
    if (!this.state.transService) {
      let pluginList = this.props.plugins.filter(
        (item) => item.type === "translation"
      );
      if (pluginList.length > 0) {
        this.setState({
          transService: pluginList[0].key,
        });
        ConfigService.setReaderConfig("transService", pluginList[0].key);
        await new Promise((resolve) => setTimeout(resolve, 100));
      } else {
        this.setState({
          isAddNew: true,
        });
      }
    }

    this.handleTrans(originalText);
  }
  UNSAFE_componentWillReceiveProps(nextProps: PopupTransProps) {
    if (nextProps.originalText !== this.props.originalText) {
      let originalText = nextProps.originalText.replace(/(\r\n|\n|\r)/gm, "");
      this.setState({
        originalText: originalText,
        translatedText: this.props.t("Model is starting, please wait..."),
      });
      this.handleTrans(originalText);
    }
  }

  handleTrans = async (text: string) => {
    const service = ConfigService.getReaderConfig("transService");
    if (!service) return;
    const plugin = this.props.plugins.find((item) => item.key === service);
    if (!plugin) return;
    const builtinTranslate = getBuiltinTranslation(plugin.key);
    const translate = builtinTranslate
      ? builtinTranslate
      : isCustomRendererPlugin(plugin)
        ? executeCustomTranslation(plugin)
        : undefined;
    if (!translate) return;
    translate(
      text,
      ConfigService.getReaderConfig("transSource") || "",
      ConfigService.getReaderConfig("transTarget") ||
        getDefaultTransTarget(plugin.langList),
      axios,
      plugin.config as PluginConfig
    )
      .then((res: string) => {
        if (res.startsWith("https://")) {
          openExternalUrl(res, true, "trans");
          const docs = getIframeDoc(this.props.currentBook.format);
          for (let i = 0; i < docs.length; i++) {
            const doc = docs[i];
            if (!doc) continue;
            doc.getSelection()?.empty();
          }
        } else {
          this.setState({ translatedText: res });
        }
      })
      .catch((err) => {
        toast.error(
          this.props.t("Translation failed") +
            ": " +
            (err instanceof Error ? err.message : String(err))
        );
        console.error(err);
      });
  };

  handleChangeService(target: string) {
    this.setState({ transService: target }, () => {
      ConfigService.setReaderConfig("transService", target);
      let plugin = this.props.plugins.find(
        (item) => item.key === this.state.transService
      );
      if (!plugin) {
        return;
      }
      let autoValue = plugin.autoValue;
      this.setState(
        {
          transSource: autoValue,
          transTarget: getDefaultTransTarget(plugin.langList),
        },
        () => {
          ConfigService.setReaderConfig(
            "transTarget",
            getDefaultTransTarget(plugin?.langList)
          );
          ConfigService.setReaderConfig("transSource", autoValue);
          this.handleTrans(
            this.props.originalText.replace(/(\r\n|\n|\r)/gm, "")
          );
        }
      );
    });
  }
  render() {
    const renderNoteEditor = () => {
      return (
        <div className="trans-container">
          <div className="trans-service-selector-container">
            <div
              className="trans-service-selector-inactive"
              onClick={() => {
                this.props.handleOpenMenu(false);
                this.props.handleMenuMode("");
                this.props.handleSetting(true);
                this.props.handleSettingMode("plugins");
              }}
            >
              <span className="icon-add trans-add-icon"></span>
              <Trans>Add</Trans>
            </div>
            {this.props.plugins
              .filter((item) => item.type === "translation")
              .map((item) => {
                return (
                  <div
                    className={
                      this.state.transService === item.key
                        ? "trans-service-selector"
                        : "trans-service-selector-inactive"
                    }
                    onClick={() => {
                      this.setState({ isAddNew: false });
                      this.handleChangeService(item.key);
                    }}
                  >
                    <span className={`icon-${item.icon} trans-icon`}></span>
                    {this.props.t(item.displayName)}
                  </div>
                );
              })}
          </div>
          {this.state.isAddNew && (
            <div
              style={{
                marginTop: "50px",
                textAlign: "center",
                fontSize: "17px",
                color: "#f16464",
              }}
            >
              <span
                style={{
                  textDecoration: "underline",
                  cursor: "pointer",
                  textAlign: "center",
                }}
                onClick={() => {
                  this.props.handleOpenMenu(false);
                  this.props.handleMenuMode("");
                  this.props.handleSetting(true);
                  this.props.handleSettingMode("plugins");
                }}
              >
                <Trans>Add new plugin</Trans>
              </span>
            </div>
          )}
          {!this.state.isAddNew && (
            <>
              <div
                className="trans-box"
                style={
                  this.props.isDockedRight
                    ? { flexDirection: "column", height: "calc(100% - 80px)" }
                    : undefined
                }
              >
                <div
                  className="original-text-box"
                  style={
                    this.props.isDockedRight
                      ? {
                          flex: 1,
                          minHeight: 0,
                          borderRight: "1px solid rgba(0,0,0,0.05)",
                          borderBottom: "1px solid rgba(0,0,0,0.05)",
                          borderBottomLeftRadius: 0,
                          borderTopRightRadius: "7px",
                        }
                      : undefined
                  }
                >
                  <div className="original-lang-box">
                    <select
                      className="original-lang-selector"
                      style={{ maxWidth: "120px", margin: 0 }}
                      value={ConfigService.getReaderConfig("transSource")}
                      onChange={(
                        event: React.ChangeEvent<HTMLSelectElement>
                      ) => {
                        let targetLang = event.target.value;
                        ConfigService.setReaderConfig(
                          "transSource",
                          targetLang
                        );
                        this.handleTrans(
                          this.props.originalText.replace(/(\r\n|\n|\r)/gm, "")
                        );
                        this.forceUpdate();
                      }}
                    >
                      {this.props.plugins.find(
                        (item) => item.key === this.state.transService
                      )?.langList &&
                        Object.keys(
                          this.props.plugins.find(
                            (item) => item.key === this.state.transService
                          )?.langList as any
                        ).map((item, index) => {
                          return (
                            <option
                              value={item}
                              key={index}
                              className="add-dialog-shelf-list-option"
                            >
                              {this.props.t(
                                Object.values(
                                  this.props.plugins.find(
                                    (item) =>
                                      item.key === this.state.transService
                                  )?.langList as any[]
                                )[index]
                              )}
                            </option>
                          );
                        })}
                    </select>
                  </div>
                  <div className="original-text">{this.state.originalText}</div>
                </div>
                <div
                  className="trans-text-box"
                  style={
                    this.props.isDockedRight
                      ? { flex: 1, minHeight: 0 }
                      : undefined
                  }
                >
                  <div className="trans-lang-box">
                    <select
                      className="trans-lang-selector"
                      style={{ maxWidth: "120px", margin: 0 }}
                      value={
                        ConfigService.getReaderConfig("transTarget") ||
                        getDefaultTransTarget(
                          this.props.plugins.find(
                            (item) => item.key === this.state.transService
                          )?.langList
                        )
                      }
                      onChange={(
                        event: React.ChangeEvent<HTMLSelectElement>
                      ) => {
                        let targetLang = event.target.value;
                        ConfigService.setReaderConfig(
                          "transTarget",
                          targetLang
                        );
                        this.handleTrans(
                          this.props.originalText.replace(/(\r\n|\n|\r)/gm, "")
                        );
                        this.forceUpdate();
                      }}
                    >
                      {this.props.plugins.find(
                        (item) => item.key === this.state.transService
                      )?.langList &&
                        Object.keys(
                          this.props.plugins.find(
                            (item) => item.key === this.state.transService
                          )?.langList as any
                        ).map((item, index) => {
                          return (
                            <option
                              value={item}
                              key={index}
                              className="add-dialog-shelf-list-option"
                            >
                              {this.props.t(
                                Object.values(
                                  this.props.plugins.find(
                                    (item) =>
                                      item.key === this.state.transService
                                  )?.langList as any[]
                                )[index]
                              )}
                            </option>
                          );
                        })}
                    </select>
                  </div>
                  <div className="trans-text">{this.state.translatedText}</div>
                </div>
              </div>
            </>
          )}
        </div>
      );
    };

    return renderNoteEditor();
  }
}
export default PopupTrans;
