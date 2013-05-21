"use strict";

var emproxy = require('emproxy');
var emsoap = require('emsoap');
var emutils = require('emutils');

var wsdlcollection = emsoap.subsystems.wsdlcollection;

var cdmTypes =
{
    string: "String",
    number : "Real",
    boolean : "Boolean",
    date : "Date"
};

function getCdmType(jsonType) {
    var ctype = cdmTypes[jsonType];
    return ctype ? ctype : "String";
}

emproxy.init(function afterInitCallback(initialConfig) {
    console.dir(initialConfig);
    emproxy.start(processDirective);
});

function processDirective(restRequest,callback) {
    var found = false;
    if (restRequest.op === 'INVOKE' && restRequest.targetType === "WsdlTools") {
        switch (restRequest.name) {
            case "getWsdlCollection":
                found = true;
                getWsdlCollection(restRequest.params, callback);
                break;

            case "createWsdlModel":
                found = true;
                createWsdlModel(restRequest.params, callback);
                break;

            case "createModelRestRequests":
                found = true;
                createModelRestRequests(restRequest.params, callback);
                break;
        }
    }

    if (!found) {
        return callback(new Error("Unsupported request type."));
    }
}

function getWsdlCollection(params, cb) {
    wsdlcollection.makeWsdlCollection(null, params.wsdlUrl, params.username, params.password,
        function(err, collection) {
            if (err) {
                cb(err);
            }
            else {
                var restResponse = {
                    status:"SUCCESS",
                    count: 1,
                    results: [collection]
                }
                cb(null, restResponse);
            }
        });
}

function createWsdlModel(params, cb) {
    try {
        var wsdl = params.wsdl;
        var opDefs = params.opDefs;
        var svcName = params.serviceName;
        var svcTypeName = svcName + "_ServiceType";

        wsdl.typeDirectory = createTypeDirectory(wsdl);
        var types = [];

        var svcType = createType(svcTypeName, [], false);
        types.push(svcType);

        var allOps = [];
        var allModelTypes = {};
        var otherTypes = {};
        var numOps = 0;

        for (var opName in opDefs.operations) {
            if (opDefs.operations[opName]) {
                numOps++;
                var op = wsdl.operations[opName];
                var inputParts =  [];
                var outputParts = [];
                var opdesc = {operation: op, inputParts: inputParts, outputParts: outputParts};
                allOps.push(opdesc);
                if (op.input) {
                    simplifyRequestParams(wsdl, op.input);
                    var isEncoded = op.input.use == "ENCODED";
                    var inputParams = op.input.params ? op.input.params : op.input.parts;
                    inputParams.forEach(function(part) {
                        processPart(wsdl, part, "in", inputParts, allModelTypes, otherTypes, isEncoded);
                    });
                }
                if (op.output) {
                    unwrapResponse(wsdl, op.output);
                    var isEncoded = op.output.use == "ENCODED";
                    op.output.parts.forEach(function(part) {
                        processPart(wsdl, part, "out", outputParts, allModelTypes, otherTypes, isEncoded);
                    });
                }
                var rtnType;
                if (outputParts.length > 0) {
                    rtnType = outputParts[0].typeName;
                    if (outputParts.length > 1) {
                        rtnType = opName + "__returnType";
                        var rtnTypeProps = [];
                        outputParts.forEach(function(outPart) {
                            rtnTypeProps.push(
                                {
                                    "name": outPart.name,
                                    "typeName": outPart.typeName,
                                    "cardinality": "one"
                                }
                            );
                        });
                        types.push(createType(rtnType, rtnTypeProps, false, "out"));
                    }
                }
                svcType.operations.push(createOp(op.name, inputParts, rtnType));
            }
        }
        if (numOps == 0) {
            return cb(new Error("No operations were enabled."));
        }

        for (var tname in allModelTypes) {
            var type = allModelTypes[tname];
            if (type.type.enumeratedValues) {
                types.push(createEnumeratedType(type.typeName, type.type.jsonType, type.type.enumeratedValues));
            }
            else {
                types.push(createType(type.typeName, type.propertySet, type.isEmbedded, type.usage));
            }
        }

        var proxyConfig = emutils.merge(params.proxyConfig, {});
        var proxyModel = {wsdl : wsdl, allOps : allOps, allModelTypes: allModelTypes, otherTypes : otherTypes, serviceType: svcTypeName};
        emutils.merge(generateProxyConfig(proxyModel), proxyConfig);
        var endpoint = null;
        if (proxyConfig && proxyConfig.soapAddress) {
            endpoint = proxyConfig.soapAddress;
        }
        else if (wsdl.soapAddress) {
            endpoint = (wsdl.soapAddress.isHttps ? "https" : "http") + "://" + wsdl.soapAddress.hostname +
                (wsdl.soapAddress.port ? ":" + wsdl.soapAddress.port : "") + wsdl.soapAddress.path;
        }
        var sys = createExternalSystem(svcName, endpoint, proxyConfig, types);
        var restResponse = {
            status:"SUCCESS",
            count: 1,
            results: [sys]
        }
        return cb(null, restResponse);
    }
    catch (err) {
        return cb(err);
    }

    function createType(typeName, props, isEmbedded, usage) {
        var propsCopy = emutils.cloneArray(props);
        propsCopy.forEach(function(row) {
            if (emutils.isReservedPropertyName(row.name)) {
                row.name = emutils.getCdmPropertyName(row.name);
            }
        });
        var def =
        {
            type: "Type Definition",
            name: typeName,
            properties: propsCopy,
            usage : usage,
            isEnum : false,
            isEmbedded: isEmbedded,
            operations:[]
        };
        return def;
    }

    function createEnumeratedType(typeName, baseType, values) {
        var def =
        {
            type: "Type Definition",
            name: typeName,
            baseType: baseType,
            values : values,
            isEnum : true
        };
        return def;
    }

    function createOp(opName, params, returnType) {
        var def =
        {
            type: "Operation Definition",
            name: opName,
            parameters: params,
            returnType : returnType
        };
        return def
    }

    function createExternalSystem(systemName, accessAddress, proxyConfig, types) {
        var def =
        {
            type: "External System Definition",
            name: systemName,
            accessAddress: accessAddress,
            proxyConfig : proxyConfig,
            types : types
        };
        return def;
    }

    function mergeUsage(type, usage) {
        switch (usage) {
            case "in":
            case "out":
            case "inout":
                break;

            default:
                throw new Error(usage  + " is not a valid type usage");
        }
        if (usage == "inout") {
            type.usage = usage;
        }
        else if (!type.usage) {
            type.usage = usage;
        }
        else if (type.usage != usage) {
            type.usage = "inout";
        }
    }

    function processPart(wsdl, part, usage, allParts, allModelTypes, otherTypes, isEncoded) {

        var desc;
        if (part.elementName) {
            var elm = wsdl.elements[makeQualifiedName(part.elementNs, part.elementName)];
            desc = getTypeDescFromName(wsdl, elm.jsonType, elm.isEnum, elm.xmlTypeNs, elm.xmlType);
        }
        else {
            desc = getTypeDescFromName(wsdl, part.jsonType, part.isEnum, part.xmlTypeNs, part.xmlType);
        }
        allParts.push({name : part.name, typeName: desc.ctype, targetType : "CdmParameter", cardinality : desc.isArray ? "many" : "one"});
        if (desc.isComplexType || desc.isEnum) {
            if (isEncoded && desc.isArray) {
                part.xmlTypeNs = desc.type.ns;
                part.xmlType = desc.type.name;
                part.isArray = true;
            }
            processType(wsdl, usage, desc.type, desc, allModelTypes, otherTypes, false);
        }
    }

    function processType(wsdl, usage, type, desc, allModelTypes, otherTypes, isEmbedded) {
        var typeModel = allModelTypes[desc.ctype];
        if (typeModel) {
            mergeUsage(typeModel, usage);
            return;
        }

        typeModel = {typeName: desc.ctype, isEmbedded : isEmbedded, type: desc.type, usage: usage};
        allModelTypes[desc.ctype] = typeModel;
        if (!desc.isEnum) {
            var props = [];
            typeModel.propertySet = props;
            processTypeContent(wsdl, usage, allModelTypes, otherTypes, type, props);
        }
    }

    function processTypeContent(wsdl, usage, allModelTypes, otherTypes, type, props) {
        if (type.baseTypeNs && type.baseTypeNs != emsoap.namespaces.SOAPENC_NS && type.baseTypeNs != emsoap.namespaces.XSD_NS) {
            var baseQName = makeQualifiedName(type.baseTypeNs, type.baseTypeName);
            var baseType = wsdl.types[baseQName] ;
            otherTypes[baseQName] = {typeName: baseQName, type: baseType};
            processTypeContent(wsdl, allModelTypes, otherTypes, baseType, props);
        }
        type.content.forEach(function(field) {
            var fdesc = {name: field.name};
            props.push(fdesc);

            if (field.maxOccurs > 1 || field.maxOccurs < 0) {
                fdesc.cardinality = "oneToMany";
            }
            fdesc.required = field.minOccurs != 0;
            var tdesc = getTypeDescFromName(wsdl, field.jsonType, field.isEnum, field.xmlTypeNs, field.xmlType);
            fdesc.type = tdesc.ctype;
            if (tdesc.isArray) {
                fdesc.cardinality = "oneToMany";
            }
            if (tdesc.isComplexType  || tdesc.isEnum)  {
                processType(wsdl, usage, tdesc.type, tdesc, allModelTypes, true);
            }
        });
    }

    function createTypeDirectory(wsdl) {
        var directory = {};
        var key;
        for (var typeName in wsdl.types) {
            var type = wsdl.types[typeName];
            if (type.isSynthetic) {
                key = type.stem = type.name.slice(0, -7);
            }
            else {
                key = type.name;
            }

            if (directory[key]) {
                directory[key]++;
            }
            else {
                directory[key] = 1;
            }
        }
        return directory;
    }


    function makeQualifiedName(ns, name) {
        return ns ? '{' + ns + '}' + name : name;
    }

    function makeJsonType(jtype) {
        return {jsonType : jtype};
    }

    function getTypeDesc(type, typeDirectory) {
        var desc = {};
        if (type.jsonType && !type.enumeratedValues) {
            desc.ctype = getCdmType(type.jsonType);
        }
        else {
            desc.isComplexType = !type.jsonType;
            var simpleName;
            var uniqueName;
            if (type.isSynthetic) {
                simpleName = type.stem;
                uniqueName = type.name;
            }
            else {
                simpleName = type.name;
                uniqueName = type.name + "_" + type.nsChecksum;
            }
            desc.ctype = typeDirectory[simpleName] > 1 ? uniqueName : simpleName;
        }
        return desc;
    }

    function getTypeDescFromName(wsdl, jsonType, isEnum, ns, local) {
        var isArray;
        var type;
        if (jsonType && (!isEnum || jsonType != "string")) {
            type = makeJsonType(jsonType);
        }
        else {
            type = wsdl.types[makeQualifiedName(ns, local)];
            if (type.baseTypeName == "Array" && type.baseTypeNs == emsoap.namespaces.SOAPENC_NS) {
                isArray = true;
                var rowDesc = type.content[0];
                if (rowDesc.jsonType) {
                    type = makeJsonType(rowDesc.jsonType);
                }
                else {
                    type = wsdl.types[makeQualifiedName(rowDesc.xmlTypeNs, rowDesc.xmlType)];
                }
            }
        }

        var desc = getTypeDesc(type, wsdl.typeDirectory);
        desc.isArray = isArray;
        desc.type = type;
        desc.isEnum = isEnum;
        return desc;
    }

    function simplifyRequestParams(wsdl, opInput) {
        var shouldSimplify = false;
        var names = {};
        var params = [];
        opInput.parts.forEach(function(part) {
            var desc;
            var name;
            if (part.elementName) {
                var elm = wsdl.elements[makeQualifiedName(part.elementNs, part.elementName)];
                name = part.elementName;
                desc = getTypeDescFromName(wsdl, elm.jsonType, elm.isEnum, elm.xmlTypeNs, elm.xmlType);
            }
            else {
                desc = getTypeDescFromName(wsdl, part.jsonType, part.isEnum, part.xmlTypeNs, part.xmlType);
                name = part.name;
            }
            var type = desc.type;
            if (type.jsonType) {
                if (names[name]) {
                    return;
                }
                names[name] = true;
                params.push(part);
            }
            else {
                shouldSimplify = true;
                desc.type.content.forEach(function(row) {
                    if (names[row.name]) {
                        return;
                    }
                    if (emutils.hasValue(row.maxOccurs) &&  row.maxOccurs != 1) {
                        return;
                    }
                    names[row.name] = true;
                    var param =
                    {
                        parentName : part.name,
                        name : row.name,
                        ns : row.ns,
                        xmlType : row.xmlType,
                        xmlTypeNs : row.xmlTypeNs,
                        jsonType : row.jsonType,
                        isAttr : row.isAttr,
                        isEnum: row.isEnum
                    };
                    params.push(param);
                });
            }
        });

        if (!shouldSimplify) {
            return;
        }
        opInput.params = params;
    }

    function unwrapResponse(wsdl, opOutput) {
        if (!opOutput.parts || opOutput.parts.length != 1) {
            return;
        }
        var part = opOutput.parts[0];
        var desc;
        if (part.elementName) {
            var elm = wsdl.elements[makeQualifiedName(part.elementNs, part.elementName)];
            desc = getTypeDescFromName(wsdl, elm.jsonType, elm.isEnum, elm.xmlTypeNs, elm.xmlType);
        }
        else {
            desc = getTypeDescFromName(wsdl, part.jsonType, part.isEnum, part.xmlTypeNs, part.xmlType);
        }
        var type = desc.type;
        if (type.jsonType) {
            return;
        }
        var count = 0;
        var field;
        while (type.content.length == 1 && type.content[0].maxOccurs != -1) {
            count++;
            field = type.content[0];
            if (type.jsonType) {
                break;
            }
            desc = getTypeDescFromName(wsdl, field.jsonType, field.isEnum, field.xmlTypeNs, field.xmlType);
            type = desc.type;
            if (type.jsonType) {
                break;
            }
        }
        if (count > 0) {
            opOutput.skipLevels = count;
            part.ns = field.ns;
            part.name = field.name;
            part.jsonType = field.jsonType;
            part.isEnum = field.isEnum;
            part.xmlTypeNs = field.xmlTypeNs;
            part.xmlType = field.xmlType;
            delete part.elementName;
            delete part.elementNs;
        }
    }

    function generateProxyConfig(model) {
        var types = {};

        var service =
        {
            serviceType: model.serviceType,
            httpOptions:
            {
                hostname : model.wsdl.soapAddress.hostname,
                port : model.wsdl.soapAddress.port,
                path: model.wsdl.soapAddress.path,
                isHttps: model.wsdl.soapAddress.isHttps,
                method: "POST"
            },
            operations: {},
            types: []
        }

        for (var name in model.allModelTypes) {
            var type = model.allModelTypes[name].type;
            if (!type.enumeratedValues) {
                types[makeQualifiedName(type.ns, type.name)] = type;
            }
        }

        for (var name in model.otherTypes) {
            var type = model.otherTypes[name].type;
            types[makeQualifiedName(type.ns, type.name)] = type;
        }

        for (var typeName in types) {
            var type = model.wsdl.types[typeName];
            if (type.content) {
                type.content.forEach(function(item, index, array) {
                    if (item.xmlTypeNs) {
                        var itemType = model.wsdl.types[makeQualifiedName(item.xmlTypeNs, item.xmlType)];
                        if (itemType.baseTypeName == "Array" && itemType.baseTypeNs == emsoap.nameapace.SOAPENC_NS) {
                            item.isArray = true;
                            item.isEnum = itemType.content[0].isEnum;
                            item.xmlTypeNs = itemType.content[0].xmlTypeNs;
                            item.xmlType = itemType.content[0].xmlType;
                            item.jsonType = itemType.content[0].jsonType;
                        }
                    }
                    if (item.isEnum) {
                        var copy = emutils.clone(item);
                        delete copy.xmlType;
                        delete copy.xmlTypeNs;
                        array[index] = copy;
                    }
                    if (emutils.isReservedPropertyName(item.name)) {
                        item.jsName = emutils.getCdmPropertyName(item.name);
                    }
                });
            }
        }

        model.allOps.forEach(function(modelOp) {
            var operation = modelOp.operation;
            var opName = operation.name;
            var isRpc;
            if (operation.style) {
                isRpc = operation.style == "RPC";
            }
            else {
                isRpc = model.wsdl.style == "RPC";
            }
            var descOp = {};
            service.operations[opName] = descOp;

            if (operation.input) {
                var isEncoded = operation.input.use == "ENCODED";
                descOp.requestDesc =
                {
                    opName : opName,
                    opNs: operation.namespace ? operation.namespace : model.wsdl.namespace,
                    soapAction: operation.soapAction,
                    isEncoded: isEncoded,
                    isRpc : isRpc,
                    soapVersion : model.wsdl.version,
                    parts: operation.input.parts
                }
                if (operation.input.params) {
                    descOp.inputParams = {};
                    operation.input.params.forEach(function(param) {
                        descOp.inputParams[param.name] = param;
                    });
                }
                descOp.requestDesc.parts.forEach(function(part) {
                    if (part.elementName) {
                        var elm = model.wsdl.elements[makeQualifiedName(part.elementNs, part.elementName)];
                        part.xmlType = elm.xmlType;
                        part.xmlTypeNs = elm.xmlTypeNs;
                    }
                    if (part.xmlType) {
                        var partTypeName = makeQualifiedName(part.xmlTypeNs, part.xmlType);
                        var partType = model.wsdl.types[partTypeName];
                        if (!types[partTypeName]) {
                            types[partTypeName] = partType;
                        }
                    }
                    if (emutils.isReservedPropertyName(part.name)) {
                        part.jsName = emutils.getCdmPropertyName(part.name);
                    }
                });
            }

            if (operation.output) {
                var isEncoded = operation.output.use == "ENCODED";
                descOp.deserializationOptions =
                {
                    removeEnvelope : true,
                    soapEncoded: isEncoded,
                    skipLevels: operation.output.skipLevels
                };
                descOp.responseDesc =
                {
                    isEncoded: isEncoded,
                    isRpc : isRpc,
                    parts: operation.output.parts
                };
                descOp.responseDesc.parts.forEach(function(part) {
                    if (part.elementName) {
                        var elm = model.wsdl.elements[makeQualifiedName(part.elementNs, part.elementName)];
                        part.xmlType = elm.xmlType;
                        part.xmlTypeNs = elm.xmlTypeNs;
                    }
                    if (emutils.isReservedPropertyName(part.name)) {
                        part.jsName = emutils.getCdmPropertyName(part.name);
                    }
                });

            }
        });

        for (typeName in types) {
            var type = emutils.clone(types[typeName]);
            type.fullName = typeName;
            service.types.push(type);
        }
        return service;
    }


}

function createModelRestRequests(params, cb) {
    var restRequests = [];
    var model = params.model;
    if (params.createExternalSystem) {
        createExternalSystem(restRequests, model.accessAddress, 
            model.proxyConfig, model.name);
    }
    else {
        updateExternalSystem(restRequests, model.proxyConfig);
    }

    model.types.forEach(function(type) {
        if (type.isEnum) {
            createType(restRequests, type.name, null, false, null, type.values, type.baseType);
        }
        else {
            createType(restRequests, type.name, type.properties, type.isEmbedded, 
                model.name + "_ServiceType");
            bindType(restRequests, type.name, model.name);
            type.operations.forEach(function(op) {
                addOperation(restRequests, type.name, op.name, model.name, 
                    op.returnType, op.parameters);
            });
        }
    });

    var restResponse = {
        status:"SUCCESS",
        count: restRequests.count,
        results: restRequests
    }
    cb(null, restResponse);

    function updateExternalSystem(model, proxyConfig) {
        var params = {};
        var pConfig = {};

        if (proxyConfig) {
            for (var name in proxyConfig) {
                var value = proxyConfig[name];
                if (value != null && value != undefined) {
                    pConfig[name] = value;
                }
            }
        }
        params.proxyConfiguration = pConfig;
        model.push(
            {
                "op": "UPDATE",
                "targetType": "CdmExternalSystem",
                "values": params,
                "where" :
                {
                    id : "999"
                }
            }
        )
    }

    function createExternalSystem(model, wsdlSoapAddress, proxyConfig, name) {
        var params = { name: name, globalPackageName : "wsdlProxy" };
        var endpoint = null;
        if (proxyConfig && proxyConfig.soapAddress) {
            endpoint = proxyConfig.soapAddress;
        }
        else if (wsdlSoapAddress) {
            endpoint = wsdlSoapAddress;
        }
        if (endpoint) {
            params.accessAddress = endpoint;
        }
        var pConfig = {};

        if (proxyConfig) {
            for (var name in proxyConfig) {
                var value = proxyConfig[name];
                if (value != null && value != undefined) {
                    pConfig[name] = value;
                }
            }
        }
        params.proxyConfiguration = pConfig;

        model.push(
            {
                "op": "INVOKE",
                "targetType": "CdmExternalSystem",
                "name": "createExternalSystem",
                "params": params
            }
        )
    }

    function createType(model, name, props, isEmbedded, svcType, enumeratedValues, enumType) {
        var params;
        var propsCopy = emutils.cloneArray(props);
        propsCopy.forEach(function(row) {
            if (emutils.isReservedPropertyName(row.name)) {
                row.name = emutils.getCdmPropertyName(row.name);
            }
        });
        if (enumeratedValues) {
            var values = [];
            enumeratedValues.forEach(function(val) {
                values.push({"targetType" : "CdmEnumeration", "value":val, "label" : val});
            });
            params = {
                "typeName": name,
                "storage": "scalar",
                "scalarBaseType": getCdmType(enumType),
                "scalarInheritsFrom": getCdmType(enumType),
                "isEnumerated" : true,
                "isScalar" : true,
                "extensionAllowed": true,
                "externallySourced": true,
                "propertySet": propsCopy,
                "enumeration" : values
            };
        }
        else {
            params = {
                "typeName": name,
                "storage": (isEmbedded ? "embedded" : "virtual"),
                "baseTable": (isEmbedded ? svcType : undefined),
                "extensionAllowed": true,
                "externallySourced": true,
                "propertySet": props
            };
        }
        params.replace = true;
        model.push(
            {"op": "INVOKE",
                "targetType": "CdmSimpleSchemaOperations",
                "name": "deleteCdmOperations",
                "params": {typeName : name}
            });
        model.push(
            {"op": "INVOKE",
                "targetType": "CdmType",
                "name": "alterCdmType",
                "params": params
            });
    }

    function bindType(model, typeName, svcName) {
        model.push({
            "op": "INVOKE",
            "targetType": "CdmSimpleSchemaOperations",
            "name": "bindCdmType",
            "params": {
                "cdmType": typeName,
                "targetType": typeName,
                "externalSystem": svcName,
                "bindingProps": {
                    "readStrategy": "sync",
                    "cacheMode": "direct",
                    "sourceStrategy": "sync",
                    "uniqueExternalId": true
                }
            }
        });
    }

    function addOperation(model, typeName, opName, svcName, rtnType, params) {
        model.push({
            "op": "INVOKE",
            "targetType": "CdmSimpleSchemaOperations",
            "name": "createAndBindCdmOperation",
            "params": {
                "targetType": typeName,
                "operationProps": {
                    "name" : opName,
                    "objectType" : typeName,
                    "returnType": rtnType,
                    "parameters": params
                }
            }
        });
    }
        
}


