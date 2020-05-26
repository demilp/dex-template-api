import axios from "axios";
import isEqual from "lodash/isEqual";
import * as io from "socket.io-client";
import { Subject } from "rxjs";
import { first } from "rxjs/operators";

export default class DexTemplateService {
  constructor(appName, options) {
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
          this.log("Received metadata " + JSON.stringify(content));
          if (!isEqual(content, self.metadata)) {
            this.log(
              "Metadata changed from " +
                JSON.stringify(self.metadata) +
                " to " +
                JSON.stringify(content)
            );
            self.metadata = content;
            self.metadataSubject.next(self.metadata);
          }
        } else if (data.type === "ip") {
          this.log("Received ip " + content);
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
    this.log("Requesting metadata");
    if (window.parent === window) {
      if (this.useDebugMetadata) {
        let meta =
          typeof this.debugMetadata === "function"
            ? this.debugMetadata()
            : this.debugMetadata;
        if (!isEqual(meta, this.metadata)) {
          this.log(
            "Metadata changed from " +
              JSON.stringify(this.metadata) +
              " to " +
              JSON.stringify(meta)
          );
          this.metadata = meta;
          this.metadataSubject.next(meta);
        }
      } else
        axios
          .get("http://localhost:9501/DexClient/GetMachineInfo.json")
          .then((response) => {
            if (response.data && response.data.MachineMetadata) {
              let metadata = {
                ...response.data.MachineMetadata,
                Id: response.data.MachineId,
              };
              this.log("Received metadata " + JSON.stringify(metadata));
              if (!isEqual(metadata, this.metadata)) {
                this.log(
                  "Metadata changed from " +
                    JSON.stringify(this.metadata) +
                    " to " +
                    JSON.stringify(metadata)
                );
                this.metadata = metadata;
                this.metadataSubject.next(this.metadata);
              }
            }
          })
          .catch((error) => {
            /* if (__config.useDebugMetadata)
            this.metadataSubject.next(testMetadata); */
          });
    } else window.parent.postMessage(getMetadataRequest, "*");
  }

  broadcast(data) {
    this.log("Sending broadcast " + JSON.stringify(data));
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
    if (window.parent === window) {
      //if (process.env.NODE_ENV !== "production") {
      this.ip = "localhost";
      this.ipSubject.next(this.ip);
    } else {
      this.log("Requesting ip address");
      window.parent.postMessage(getIPRequest, "*");
    }
    //}
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
        this.log("Development socket created");
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
