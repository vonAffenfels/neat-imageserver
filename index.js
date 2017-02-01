"use strict";

// @IMPORTS
const Application = require("neat-base").Application;
const Module = require("neat-base").Module;
const Tools = require("neat-base").Tools;
const gm = require("gm");
const fs = require("fs");
const mkdirp = require('mkdirp');
const recursive = require('recursive-readdir');
const Promise = require("bluebird");
const _ = require("underscore");
const Distributor = require("distribute-files").Distributor;

module.exports = class Imageserver extends Module {

    static defaultConfig() {
        return {
            dbModuleName: "database",
            webserverModuleName: "webserver",
            imagesDir: "/data/images/",
            fileModelName: "file",
            fileModuleName: "file",
            fileUrlPropertyName: "fileurl",
            domain: "//localhost:13337",
            imageRoute: "/image/",
            packages: {
                thumb: {
                    type: "recrop",
                    width: 200,
                    height: 200,
                    gravity: "Center",
                    quality: 80
                }
            }
        }
    }

    /**
     *
     */
    init() {
        return new Promise((resolve, reject) => {
            this.log.debug("Initializing...");

            // load Model
            let fileModel = Application.modules[this.config.dbModuleName].getModel("file");

            // set paths
            this.imagesDir = Application.config.root_path + this.config.imagesDir;

            // create dirs
            mkdirp.sync(this.imagesDir);

            if (Application.modules[this.config.webserverModuleName]) {
                Application.modules[this.config.webserverModuleName].addRoute("get", this.config.imageRoute + ":id-:pkg.:ext", (req, res) => {
                    let id = req.params.id;
                    let pkg = req.params.pkg;
                    let ext = req.params.ext;

                    if (!id || !pkg || !ext) {
                        res.status(404);
                        return res.end();
                    }

                    if (!this.config.packages[pkg]) {
                        res.status(400);
                        return res.end("pkg definition missing for " + pkg);
                    }

                    if (req.query.purge) {
                        this.purge(pkg)
                    }

                    let packageOptions = this.config.packages[pkg];

                    if ([
                            "png",
                            "jpg",
                            "jpeg",
                            "bmp",
                            "eps",
                            "tif",
                            "gif"
                        ].indexOf(ext) === -1) {
                        res.status(400);
                        return res.end("invalid extension " + ext);
                    }

                    fileModel.findOne({
                        _id: id
                    }).exec().then((doc) => {

                        if (!doc) {
                            res.status(404);
                            return res.end();
                        }

                        let fullFilePath = Application.config.root_path + doc.filepath;
                        let targetFileName = doc._id + "-" + pkg + "." + ext;
                        let targetPath = this.imagesDir + "/" + targetFileName;

                        try {
                            fs.accessSync(fullFilePath, fs.R_OK);
                        } catch (e) {
                            res.status(500);
                            return res.end("File is missing!");
                        }

                        if (!req.query.noCache) {
                            try {
                                fs.accessSync(targetPath, fs.R_OK);
                                return res.sendFile(targetPath);
                            } catch (e) {

                            }
                        }

                        let gmObj = gm(fullFilePath);

                        if (packageOptions instanceof Array) {
                            //@TODO chain multiple commmands
                        } else {
                            if (packageOptions.type == "resize") {
                                gmObj.resize(packageOptions.width, packageOptions.height, packageOptions.options).quality(packageOptions.quality || 80);
                            }

                            if (packageOptions.type == "recrop") {
                                gmObj
                                    .resize(packageOptions.width, packageOptions.height, "^")
                                    .gravity(packageOptions.gravity || "Center")
                                    .quality(packageOptions.quality || 80)
                                    .crop(packageOptions.width, packageOptions.height, packageOptions.x || 0, packageOptions.y || 0);
                            }

                            if (packageOptions.type == "original") {
                                gmObj.quality(packageOptions.quality || 80);
                            }
                        }

                        gmObj.write(targetPath, (err) => {
                            if (err) {
                                res.status(500);
                                return res.end(err.toString());
                            }

                            let fileModule = Application.modules[this.config.fileModuleName];

                            if (fileModule.distributorGenerated) {
                                fileModule.distributorGenerated.distributeFile(this.config.imagesDir + "/" + targetFileName, this.config.imagesDir + "/" + targetFileName).then(() => {
                                    this.log.debug("Distributed Image");
                                }, (e) => {
                                    this.log.error("Distribution of Image " + targetPath + " failed!");
                                    this.log.error(e);
                                });
                            }

                            return res.sendFile(targetPath);
                        });
                    }, (err) => {
                        res.err(err);
                    });
                }, 0);
            }

            resolve(this);
        });
    }

    /**
     *
     * @param pkg
     */
    purge(pkg) {
        return new Promise((resolve, reject) => {
            recursive(this.imagesDir, function (err, files) {
                let regexp = new RegExp("^.*?-" + pkg + "\..*?$", "i");
                for (let i = 0; i < files.length; i++) {
                    let file = files[i];
                    if (regexp.test(file)) {
                        fs.unlink(file);
                    }
                }
            });
        })
    }

    /**
     *
     * @param doc
     * @returns {{}}
     */
    getUrls(doc) {
        let result = {};

        for (let pkg in this.config.packages) {
            result[pkg] = this.getPackageUrl(doc, pkg);
        }

        return result;
    }

    /**
     *
     * @param doc
     * @returns {{}}
     */
    getPaths(doc) {
        let result = {};

        for (let pkg in this.config.packages) {
            result[pkg] = this.getPackagePath(doc, pkg);
        }

        return result;
    }

    /**
     *
     * @param doc
     * @param pkg
     * @returns {string}
     */
    getPackageUrl(doc, pkg) {
        let pkgConfig = this.config.packages[pkg];
        let extension = doc.extension;

        if (pkgConfig.forceType) {
            extension = pkgConfig.forceType;
        }

        return this.config.domain + this.config.imageRoute + doc._id + "-" + pkg + "." + extension;
    }

    /**
     *
     * @param doc
     * @param pkg
     * @returns {string}
     */
    getPackagePath(doc, pkg) {
        let pkgConfig = this.config.packages[pkg];
        let extension = doc.extension;

        if (pkgConfig.forceType) {
            extension = pkgConfig.forceType;
        }

        return this.imagesDir + "/" + doc._id + "-" + pkg + "." + extension;
    }

    /**
     *
     * @param name
     * @param schema
     */
    modifySchema(name, schema) {
        let self = this;

        if (name === this.config.fileModelName) {

            schema.pre("remove", function (next) {
                let pgkPaths = _.values(self.getPaths(this));

                for (let i = 0; i < pgkPaths.length; i++) {
                    let file = pgkPaths[i];
                    try {
                        fs.accessSync(file, fs.R_OK);
                        fs.unlinkSync(file);
                    } catch (e) {
                    }
                }

                next();
            });

            schema.pre("save", function (next) {
                let pgkPaths = _.values(self.getPaths(this));

                for (let i = 0; i < pgkPaths.length; i++) {
                    let file = pgkPaths[i];
                    try {
                        fs.accessSync(file, fs.R_OK);
                        fs.unlinkSync(file);
                    } catch (e) {
                    }
                }

                next();
            });

            schema.post("save", function () {
                let pgkPaths = _.values(self.getPaths(this));

                for (let i = 0; i < pgkPaths.length; i++) {
                    let file = pgkPaths[i];
                    try {
                        fs.accessSync(file, fs.R_OK);
                        fs.unlinkSync(file);
                    } catch (e) {
                    }
                }
            });

            schema.virtual(this.config.fileUrlPropertyName).get(function () {
                if (this.type === "image") {
                    return self.getUrls(this);
                } else {
                    return Application.modules[self.config.fileModuleName].config.fileDir + "/" + this.filename;
                }
            });

        }

    }

}