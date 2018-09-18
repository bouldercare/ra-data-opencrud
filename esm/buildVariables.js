var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

import { GET_LIST, GET_ONE, GET_MANY, GET_MANY_REFERENCE, CREATE, UPDATE, DELETE } from 'react-admin';

import isObject from 'lodash/isObject';

import getFinalType from './utils/getFinalType';
import { computeFieldsToAddRemoveUpdate } from './utils/computeAddRemoveUpdate';

import { PRISMA_CONNECT, PRISMA_DISCONNECT, PRISMA_UPDATE } from './constants/mutations';

//TODO: Object filter weren't tested yet
const buildGetListVariables = introspectionResults => (resource, aorFetchType, params) => {
  const filter = Object.keys(params.filter).reduce((acc, key) => {
    if (key === 'ids') {
      return _extends({}, acc, { id_in: params.filter[key] });
    }

    if (Array.isArray(params.filter[key])) {
      const type = introspectionResults.types.find(t => t.name === `${resource.type.name}WhereInput`);
      const inputField = type.inputFields.find(t => t.name === key);

      if (!!inputField) {
        return _extends({}, acc, {
          [key]: { id_in: params.filter[key] }
        });
      }
    }

    if (isObject(params.filter[key])) {
      const type = introspectionResults.types.find(t => t.name === `${resource.type.name}WhereInput`);
      const filterSome = type.inputFields.find(t => t.name === `${key}_some`);

      if (filterSome) {
        const filter = Object.keys(params.filter[key]).reduce((acc, k) => _extends({}, acc, {
          [`${k}_in`]: params.filter[key][k]
        }), {});
        return _extends({}, acc, { [`${key}_some`]: filter });
      }
    }

    const parts = key.split('.');

    if (parts.length > 1) {
      if (parts[1] == 'id') {
        const type = introspectionResults.types.find(t => t.name === `${resource.type.name}WhereInput`);
        const filterSome = type.inputFields.find(t => t.name === `${parts[0]}_some`);

        if (filterSome) {
          return _extends({}, acc, {
            [`${parts[0]}_some`]: { id: params.filter[key] }
          });
        }

        return _extends({}, acc, { [parts[0]]: { id: params.filter[key] } });
      }

      const resourceField = resource.type.fields.find(f => f.name === parts[0]);
      if (resourceField.type.name === 'Int') {
        return _extends({}, acc, { [key]: parseInt(params.filter[key]) });
      }
      if (resourceField.type.name === 'Float') {
        return _extends({}, acc, { [key]: parseFloat(params.filter[key]) });
      }
    }

    return _extends({}, acc, { [key]: params.filter[key] });
  }, {});

  const ret = {
    skip: parseInt((params.pagination.page - 1) * params.pagination.perPage),
    first: parseInt(params.pagination.perPage),
    orderBy: `${params.sort.field}_${params.sort.order}`,
    where: filter
  };

  // Special hook to allow extra top-level query variables like tasks.singleEvents. If React admin passes
  // any of these extra flags, we just pass them along as is, without any validation (we could add validation
  // in future).
  if (params.additional) {
    Object.assign(ret, params.additional);
  }

  return ret;
};

const findType = (introspectionResults, typeName) => {
  return introspectionResults.types.find(t => t.name === typeName);
};

const findInputFieldForType = (introspectionResults, type, field) => {
  let inputFieldType = type.inputFields.find(t => t.name === field);
  let finalType = !!inputFieldType ? getFinalType(inputFieldType.type) : null;

  // introspection results uses a partial object instead of the full thing for representing a field whose
  // type is another input object, so if it's one of those, replace it with the real type
  if (finalType && finalType.kind === 'INPUT_OBJECT') {
    finalType = findType(introspectionResults, finalType.name);
  }

  return finalType;
};

const inputFieldExistsForType = (introspectionResults, type, field) => {
  return !!findInputFieldForType(introspectionResults, type, field);
};

const buildReferenceField = ({ inputArg, introspectionResults, type, field, mutationType }) => {
  const inputType = findInputFieldForType(introspectionResults, type, field);
  const mutationInputType = findInputFieldForType(introspectionResults, inputType, mutationType);

  return Object.keys(inputArg).reduce((acc, key) => {
    return inputFieldExistsForType(introspectionResults, mutationInputType, key) ? _extends({}, acc, { [key]: inputArg[key] }) : acc;
  }, {});
};

const buildDataVariable = (introspectionResults, type, data, previousData = {}) => {
  return Object.keys(data).reduce((acc, key) => {
    if (Array.isArray(data[key])) {
      const inputType = findInputFieldForType(introspectionResults, type, key);

      if (!inputType) {
        return acc;
      }

      //TODO: Make connect, disconnect and update overridable
      //TODO: Make updates working

      var _computeFieldsToAddRe = computeFieldsToAddRemoveUpdate(previousData[`${key}Ids`], data[`${key}Ids`]);

      const fieldsToAdd = _computeFieldsToAddRe.fieldsToAdd,
            fieldsToRemove = _computeFieldsToAddRe.fieldsToRemove;


      return _extends({}, acc, {
        [key]: {
          [PRISMA_CONNECT]: fieldsToAdd,
          [PRISMA_DISCONNECT]: fieldsToRemove
          //[PRISMA_UPDATE]: fieldsToUpdate
        }
      });
    }

    if (isObject(data[key])) {
      const inputType = findInputFieldForType(introspectionResults, type, key);

      // If the type has a "connect" option, assume it's a reference and create connect/disconnect options.
      if (inputFieldExistsForType(introspectionResults, inputType, PRISMA_CONNECT)) {
        const fieldsToUpdate = buildReferenceField({
          inputArg: data[key],
          introspectionResults,
          type: type,
          field: key,
          mutationType: PRISMA_CONNECT
        });

        // If no fields in the object are valid, continue
        if (Object.keys(fieldsToUpdate).length === 0) {
          return acc;
        }

        // Else, connect the nodes
        return _extends({}, acc, { [key]: { [PRISMA_CONNECT]: _extends({}, fieldsToUpdate) } });
      }

      // Otherwise, assume it's an embedded document and recursively create the payload. The Prisma spec on
      // embedded docs is still a work-in-progress, so for now we just directly included the processed
      // variables with no "connect/update/create/" wrapper. See https://github.com/prisma/prisma/issues/2836
      else {
          return _extends({}, acc, { [key]: buildDataVariable(introspectionResults, inputType, data[key], previousData[key]) });
        }
    }

    if (key !== 'id' && inputFieldExistsForType(introspectionResults, type, key)) {
      // Rest should be put in data object
      return _extends({}, acc, {
        [key]: data[key]
      });
    }

    return acc;
  }, {});
};

const buildUpdateVariables = introspectionResults => (resource, aorFetchType, params) => ({
  where: {
    id: params.data.id
  },
  data: buildDataVariable(introspectionResults, findType(introspectionResults, `${resource.type.name}UpdateInput`), params.data, params.previousData)
});

const buildCreateVariables = introspectionResults => (resource, aorFetchType, params) => ({
  data: buildDataVariable(introspectionResults, findType(introspectionResults, `${resource.type.name}CreateInput`), params.data)
});

export default (introspectionResults => (resource, aorFetchType, params, queryType) => {
  switch (aorFetchType) {
    case GET_LIST:
      {
        return buildGetListVariables(introspectionResults)(resource, aorFetchType, params, queryType);
      }
    case GET_MANY:
      return {
        where: { id_in: params.ids }
      };
    case GET_MANY_REFERENCE:
      {
        const parts = params.target.split('.');

        return {
          where: { [parts[0]]: { id: params.id } }
        };
      }
    case GET_ONE:
      return {
        where: { id: params.id }
      };
    case UPDATE:
      {
        return buildUpdateVariables(introspectionResults)(resource, aorFetchType, params);
      }

    case CREATE:
      {
        return buildCreateVariables(introspectionResults)(resource, aorFetchType, params);
      }

    case DELETE:
      return {
        where: { id: params.id }
      };
  }
});