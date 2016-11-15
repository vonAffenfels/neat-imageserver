"use strict";

// @IMPORTS
var Application = require("neat-base").Application;
var Module = require("neat-base").Module;
var Tools = require("neat-base").Tools;
var gm = require("gm");
var fs = require("fs");
var mkdirp = require('mkdirp');
var recursive = require('recursive-readdir');
var Promise = require("bluebird");

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
            var fileModel = Application.modules[this.config.dbModuleName].getModel("file");

            // set paths
            this.imagesDir = Application.config.root_path + this.config.imagesDir;

            // create dirs
            mkdirp.sync(this.imagesDir);

            if (Application.modules[this.config.webserverModuleName]) {
                Application.modules[this.config.webserverModuleName].addRoute("get", this.config.imageRoute + ":id-:pkg.:ext", (req, res) => {
                    var id = req.params.id;
                    var pkg = req.params.pkg;
                    var ext = req.params.ext;

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

                    var packageOptions = this.config.packages[pkg];

                    if ([
                            "png",
                            "jpg",
                            "jpeg",
                            "bmp",
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

                        var fullFilePath = Application.config.root_path + doc.filepath;
                        var targetPath = this.imagesDir + "/" + doc._id + "-" + pkg + "." + ext;

                        try {
                            fs.accessSync(fullFilePath, fs.R_OK);
                        } catch (e) {
                            res.status(500);
                            return res.end("File is missing!");
                        }

                        try {
                            fs.accessSync(targetPath, fs.R_OK);
                            return res.sendFile(targetPath);
                        } catch (e) {

                        }

                        var gmObj = gm(fullFilePath);

                        if (packageOptions instanceof Array) {
                            //@TODO chain multiple commmands
                        } else {
                            if (packageOptions.type == "resize") {
                                gmObj.resize(packageOptions.width, packageOptions.height, packageOptions.options).quality(packageOptions.quality || 50);
                            }
                            if (packageOptions.type == "recrop") {
                                gmObj
                                    .resize(packageOptions.width, packageOptions.height, "^")
                                    .gravity(packageOptions.gravity || "Center")
                                    .quality(packageOptions.quality || 50)
                                    .crop(packageOptions.width, packageOptions.height, packageOptions.x || 0, packageOptions.y || 0);
                            }
                        }

                        gmObj.write(targetPath, (err) => {
                            if (err) {
                                res.status(500);
                                return res.end(err);
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
                var regexp = new RegExp("^.*?-" + pkg + "\..*?$", "i");
                for (var i = 0; i < files.length; i++) {
                    var file = files[i];
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
        var result = {};

        for (var pkg in this.config.packages) {
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
        var result = {};

        for (var pkg in this.config.packages) {
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
        var pkgConfig = this.config.packages[pkg];
        var extension = doc.extension;

        if (pkgConfig.forceType) {
            extension = pkgConfig.forceType;
        }

        return this.config.domain + doc._id + "-" + pkg + "." + extension;
    }

    /**
     *
     * @param doc
     * @param pkg
     * @returns {string}
     */
    getPackagePath(doc, pkg) {
        var pkgConfig = this.config.packages[pkg];
        var extension = doc.extension;

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
        var self = this;

        if (name === this.config.fileModelName) {

            schema.pre("remove", function (next) {
                var pgkPaths = _.values(self.getPaths(this));

                for (var i = 0; i < pgkPaths.length; i++) {
                    var file = pgkPaths[i];
                    try {
                        fs.accessSync(file, fs.R_OK);
                        fs.unlink(file);
                    } catch (e) {
                    }
                }

                next();
            });

            schema.virtual(this.config.fileUrlPropertyName).get(function () {
                if (this.type === "image") {
                    return self.getUrls(this);
                } else {
                    return Application.modules[this.config.fileModuleName].config.fileDir + "/" + this.filename;
                }
            });

        }

    }

}