const PRESENTATIONS = {
  male: { value: 'male', text: '男', className: 'gender-male' },
  female: { value: 'female', text: '女', className: 'gender-female' },
  unknown: { value: 'unknown', text: '未填', className: 'gender-unknown' }
};

function normalize(value) {
  return value === 'male' || value === 'female' ? value : 'unknown';
}

function presentation(value) {
  return PRESENTATIONS[normalize(value)];
}

function decorate(person) {
  const source = person || {};
  const display = presentation(source.gender);
  return Object.assign({}, source, {
    gender: display.value,
    genderText: display.text,
    genderClass: display.className
  });
}

function isKnown(value) {
  return value === 'male' || value === 'female';
}

function opposite(value) {
  return value === 'male' ? 'female' : value === 'female' ? 'male' : '';
}

module.exports = {
  normalize: normalize,
  presentation: presentation,
  decorate: decorate,
  isKnown: isKnown,
  opposite: opposite
};
