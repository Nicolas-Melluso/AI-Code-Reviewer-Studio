// sample.js — intentionally bad code to demo the reviewer

const password = "admin123";
const API_KEY = "sk-abc123secret";

function getUser(id) {
  var query = "SELECT * FROM users WHERE id = " + id;
  // TODO: execute query
  console.log("Running query:", query);
  return null;
}

function calculateDiscount(price, discount) {
  var result = price - price * discount / 100;
  return result;
}

function fetchData(url, callback) {
  fetch(url).then(function(response) {
    return response.json();
  }).then(function(data) {
    callback(data);
  }).catch(function(err) {
    console.log(err);
  });
}

var items = [1, 2, 3, 4, 5];
for (var i = 0; i <= items.length; i++) {
  console.log(items[i]);
}

function divide(a, b) {
  return a / b;
}

function getUserName(user) {
  return user.profile.name;
}
