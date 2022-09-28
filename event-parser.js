const avro = require("avro-js");

function parseEvent(schema, event) {
  const allFields = schema.type.getFields();
  const replayId = event.replayId.readBigUInt64BE().toString();
  const payload = schema.type.fromBuffer(event.event.payload); // This schema is the same which we retreived earlier in the GetSchema rpc.
  payload.ChangeEventHeader.nulledFields = parseFieldBitmaps(
    allFields,
    payload.ChangeEventHeader.nulledFields
  );
  payload.ChangeEventHeader.diffFields = parseFieldBitmaps(
    allFields,
    payload.ChangeEventHeader.diffFields
  );
  payload.ChangeEventHeader.changedFields = parseFieldBitmaps(
    allFields,
    payload.ChangeEventHeader.changedFields
  );
  return {
    replayId,
    payload,
  };
}

/**
 *
 * @param {Object[]} allFields
 * @param {string[]} fieldBitmapsAsHex
 * @returns
 */
function parseFieldBitmaps(allFields, fieldBitmapsAsHex) {
  if (fieldBitmapsAsHex.length === 0) {
    return [];
  }
  let fieldNames = [];
  // Replace top field level bitmap with list of fields
  if (fieldBitmapsAsHex[0].startsWith("0x")) {
    fieldNames = fieldNames.concat(
      getFieldNamesFromBitmap(allFields, fieldBitmapsAsHex[0])
    );
  }
  // Process compound fields
  if (fieldBitmapsAsHex[fieldBitmapsAsHex.length - 1].indexOf("-") !== -1) {
    fieldBitmapsAsHex.forEach((fieldBitmapAsHex) => {
      const bitmapMapStrings = fieldBitmapAsHex.split("-");
      // Ignore top level field bitmap
      if (bitmapMapStrings.length >= 2) {
        const parentField = allFields[parseInt(bitmapMapStrings[0])];
        const childFields = getChildFields(parentField);
        const childFieldNames = getFieldNamesFromBitmap(
          childFields,
          bitmapMapStrings[1]
        );
        fieldNames = fieldNames.concat(
          childFieldNames.map(
            (fieldName) => `${parentField._name}.${fieldName}`
          )
        );
      }
    });
  }
  return fieldNames;
}

function getChildFields(parentField) {
  const types = parentField._type.getTypes();
  let fields = [];
  types.forEach((type) => {
    if (type instanceof avro.types.RecordType) {
      fields = fields.concat(type.getFields());
    } else if (type instanceof avro.types.NullType) {
      fields.push(null);
    }
  });
  return fields;
}

/**
 * Loads field names from a bitmap
 * @param {Field[]} fields list of Avro Field
 * @param {string} fieldBitmapAsHex
 */
function getFieldNamesFromBitmap(fields, fieldBitmapAsHex) {
  let binValue = hexToBin(fieldBitmapAsHex);
  binValue = reverseBytes(binValue); // Reverse byte order to match expected format
  // Use bitmap to figure out field names based on index
  const fieldNames = [];
  for (let i = 0; i < binValue.length; i++) {
    if (binValue[i] === "1") {
      fieldNames.push(fields[i].getName());
    }
  }
  return fieldNames;
}

function reverseBytes(input) {
  let output = "";
  for (let i = input.length / 8 - 1; i >= 0; i--) {
    output += input.substring(i * 8, (i + 1) * 8);
  }
  return output;
}

/**
 * Converts a hexadecimal string into a string binary representation
 * @param {string} hex
 * @returns
 */
function hexToBin(hex) {
  let bin = hex.substring(2); // Remove 0x prefix
  bin = bin.replaceAll("0", "0000");
  bin = bin.replaceAll("1", "0001");
  bin = bin.replaceAll("2", "0010");
  bin = bin.replaceAll("3", "0011");
  bin = bin.replaceAll("4", "0100");
  bin = bin.replaceAll("5", "0101");
  bin = bin.replaceAll("6", "0110");
  bin = bin.replaceAll("7", "0111");
  bin = bin.replaceAll("8", "1000");
  bin = bin.replaceAll("9", "1001");
  bin = bin.replaceAll("A", "1010");
  bin = bin.replaceAll("B", "1011");
  bin = bin.replaceAll("C", "1100");
  bin = bin.replaceAll("D", "1101");
  bin = bin.replaceAll("E", "1110");
  bin = bin.replaceAll("F", "1111");
  return bin;
}

module.exports = {
  parseEvent,
};
