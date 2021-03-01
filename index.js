import axios from "axios";
import isEqual from "lodash/isEqual";
import * as io from "socket.io-client";
import { Subject } from "rxjs";
import { first } from "rxjs/operators";

export default class DexTemplateService {
  constructor(appName, options, sendLogs) {
    this.sendLogs = sendLogs === false ? false : true;
    options = options || {};
    this.debugMetadata = options.debugMetadata || {};
    this.useDebugMetadata = options.useDebugMetadata || false;
    this.appName = appName;
    let self = this;
    this.ip = null;
    this.metadataSubject = new Subject();
    this.ipSubject = new Subject();
    this.passthroughSubject = new Subject();
    this.broadcastSubject = new Subject();

    this.metadata = null;

    window.addEventListener("message", (e) => {
      try {
        if (typeof e.data !== "object") return;
        const data = e.data;
        const content = data.content;
        if (data.type === "metadata") {
          if (sendLogs)
            this.log("Received metadata " + JSON.stringify(content));
          if (!isEqual(content, self.metadata)) {
            this.log(
              "Metadata changed from " +
                JSON.stringify(self.metadata) +
                " to " +
                JSON.stringify(content)
            );
          }
          self.metadata = content;
          self.metadataSubject.next(self.metadata);
        } else if (data.type === "ip") {
          if (this.sendLogs) this.log("Received ip " + content);
          self.ip = content === "0.0.0.0" ? "localhost" : content;
          self.ipSubject.next(self.ip);
        } else if (data.type === "sendSync") {
          self.broadcastSubject.next(data);
        }
      } catch (error) {
        this.log(error);
      }
    });
    setTimeout(() => {
      if (options.passthrough) {
        this.initPassthough();
      }
      if (options.metadataServiceInterval) {
        this.initMetadataService(options.metadataServiceInterval);
      }
    }, 0);
  }

  createSocket(ip) {
    this.log("Creating socket. IP: " + ip);
    this.socket = io(`http://${ip}:9520/passthrough`);
    this.socket.on(
      "data",
      function (msg) {
        this.passthroughSubject.next({
          ...msg,
          timestamp: new Date().toISOString(),
        });
      }.bind(this)
    );
  }

  getMetadata() {
    if (this.sendLogs) this.log("Requesting metadata");
    if (window.parent === window) {
      if (this.useDebugMetadata) {
        let meta =
          typeof this.debugMetadata === "function"
            ? this.debugMetadata()
            : this.debugMetadata;
        if (!isEqual(this.metadata, meta))
          this.log(
            "Metadata changed from " +
              JSON.stringify(this.metadata) +
              " to " +
              JSON.stringify(meta)
          );
        this.metadata = meta;
        this.metadataSubject.next(meta);
      } else
        axios
          .get("http://localhost:9501/DexClient/GetMachineInfo.json")
          .then((response) => {
            if (response.data && response.data.MachineMetadata) {
              let metadata = {
                ...response.data.MachineMetadata,
                Id: response.data.MachineId,
              };
              if (this.sendLogs) {
                this.log("Received metadata " + JSON.stringify(metadata));
                this.log(
                  "Metadata changed from " +
                    JSON.stringify(this.metadata) +
                    " to " +
                    JSON.stringify(metadata)
                );
              }

              this.metadata = metadata;
              this.metadataSubject.next(this.metadata);
            }
          })
          .catch((error) => {
            /* if (__config.useDebugMetadata)
            this.metadataSubject.next(testMetadata); */
          });
    } else window.parent.postMessage(getMetadataRequest, "*");
  }

  broadcast(data) {
    if (this.sendLogs) {
      this.log("Sending broadcast " + JSON.stringify(data));
    }
    window.parent.postMessage(
      {
        data: data,
        type: "sendSync",
        origin: "DexTemplate",
        app: this.appName,
      },
      "*"
    );
  }
  getIp() {
    if (process.env.NODE_ENV === "development") {
      this.ip = "localhost";
      return this.ipSubject.next(this.ip);
    }
    if (window.parent === window) {
      axios
        .get("http://localhost:9501/DexClient/GetMachineInfo.json")
        .then((response) => {
          if (response.data && response.data.IPs.length) {
            this.ip = response.data.IPs[0];
            return this.ipSubject.next(this.ip);
          }
        })
        .catch((error) => {
          this.ip = "localhost";
          return this.ipSubject.next(this.ip);
        });
    } else {
      if (this.sendLogs) this.log("Requesting ip address");
      window.parent.postMessage(getIPRequest, "*");
    }
  }

  initMetadataService(time) {
    setInterval(() => this.getMetadata(), time || 2 * 60 * 1000);
    this.getMetadata();
  }
  initPassthough(options) {
    options = options || {};

    if (
      window.parent === window &&
      window.EventSource &&
      options.windowsEventSource
    ) {
      // if is Windows
      var source = new EventSource(
        "http://localhost:9520/event-stream?channel=POST|" +
          options.windowsEventSource
      );
      source.addEventListener(
        "message",
        function (e) {
          if (
            e.data.startsWith(`POST|${options.windowsEventSource}@cmd.String `)
          ) {
            let msg = JSON.parse(
              JSON.parse(
                e.data.substring(17 + options.windowsEventSource.length)
              )
            );
            this.passthroughSubject.next({
              ...msg,
              timestamp: new Date().toISOString(),
            });
          }
        }.bind(this),
        false
      );
    } else {
      this.ipSubject.pipe(first()).subscribe((ip) => {
        this.createSocket(ip);
        if (this.sendLogs) this.log("Development socket created");
      });
      this.getIp();
    }
  }
  syncStatus() {
    let p = Promise.resolve();
    if (!this.ip)
      p = new Promise((resolve, reject) => {
        this.ipSubject.pipe(first()).subscribe(resolve);
        this.getIp();
      });
    return p
      .then(() => {
        return axios.get("http://" + this.ip + ":9520");
      })
      .then((request) => {
        return request.data;
      });
  }
  log(message) {
    let l = {
      type: "log",
      content: { tag: `[${this.appName}]`, message: message },
      origin: "DexTemplate",
    };
    console.log(l.content.message);
    window.parent.postMessage(l, "*");
  }

  showMediaByTag(tag) {
    let content = null;
    if (Array.isArray(tag)) {
      content = tag.map((t) => {
        return { tag: t, state: "SHOW", data: null };
      });
    } else {
      content = {
        tag,
        state: "SHOW",
        data: null,
      };
    }
    window.parent.postMessage(
      {
        origin: "DexTemplate",
        type: "setTagState",
        content,
      },
      "*"
    );
  }

  hideMediaByTag(tag, durationMinutes = null) {
    let content = null;
    if (Array.isArray(tag)) {
      content = tag.map((t) => {
        return { tag: t, state: "HIDE", data: durationMinutes };
      });
    } else {
      content = {
        tag,
        state: "HIDE",
        data: durationMinutes,
      };
    }
    window.parent.postMessage(
      {
        origin: "DexTemplate",
        type: "setTagState",
        content,
      },
      "*"
    );
  }

  hideTpl() {
    window.parent.postMessage(
      {
        origin: "DexTemplate",
        type: "tplDisplayStatus",
        content: "hide",
      },
      "*"
    );
  }

  showTpl() {
    window.parent.postMessage(
      {
        origin: "DexTemplate",
        type: "tplDisplayStatus",
        content: "show",
      },
      "*"
    );
  }

  uploadFile(name, content, mimeType) {
    window.parent.postMessage(
      {
        mimeType,
        name,
        content,
        origin: "DexTemplate",
        type: "uploadFile",
      },
      "*"
    );
  }
}

const getMetadataRequest = {
  origin: "DexTemplate",
  type: "getMetadata",
  content: {},
};
const getIPRequest = {
  origin: "DexTemplate",
  type: "getIP",
  content: {},
};
