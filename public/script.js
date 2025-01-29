// Theme toggle functionality
function initThemeToggle() {
  const themeToggle = document.getElementById("themeToggle");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");

  // Set initial theme based on system preference
  if (localStorage.getItem("theme") === null) {
    document.documentElement.setAttribute(
      "data-theme",
      prefersDark.matches ? "dark" : "light"
    );
  } else {
    document.documentElement.setAttribute(
      "data-theme",
      localStorage.getItem("theme")
    );
  }

  themeToggle.addEventListener("click", () => {
    const currentTheme = document.documentElement.getAttribute("data-theme");
    const newTheme = currentTheme === "light" ? "dark" : "light";

    document.documentElement.setAttribute("data-theme", newTheme);
    localStorage.setItem("theme", newTheme);
  });
}

// PIN input functionality
function setupPinInputs() {
  const form = document.getElementById("pinForm");
  if (!form) return; // Only run on login page

  // Fetch PIN length from server
  fetch("/pin-length") // Remove fetchConfig for this public endpoint
    .then((response) => response.json())
    .then((data) => {
      const pinLength = data.length;
      const container = document.querySelector(".pin-input-container");

      // Create PIN input fields
      for (let i = 0; i < pinLength; i++) {
        const input = document.createElement("input");
        input.type = "password";
        input.maxLength = 1;
        input.className = "pin-input";
        input.setAttribute("inputmode", "numeric");
        input.pattern = "[0-9]*";
        input.setAttribute("autocomplete", "off");
        container.appendChild(input);
      }

      // Handle input behavior
      const inputs = container.querySelectorAll(".pin-input");

      // Focus first input immediately
      if (inputs.length > 0) {
        inputs[0].focus();
      }

      inputs.forEach((input, index) => {
        input.addEventListener("input", (e) => {
          // Only allow numbers
          e.target.value = e.target.value.replace(/[^0-9]/g, "");

          if (e.target.value) {
            e.target.classList.add("has-value");
            if (index < inputs.length - 1) {
              inputs[index + 1].focus();
            } else {
              // Last digit entered, submit the form
              const pin = Array.from(inputs)
                .map((input) => input.value)
                .join("");
              submitPin(pin, inputs);
            }
          } else {
            e.target.classList.remove("has-value");
          }
        });

        input.addEventListener("keydown", (e) => {
          if (e.key === "Backspace" && !e.target.value && index > 0) {
            inputs[index - 1].focus();
          }
        });

        // Prevent paste of multiple characters
        input.addEventListener("paste", (e) => {
          e.preventDefault();
          const pastedData = e.clipboardData.getData("text");
          const numbers = pastedData.match(/\d/g);

          if (numbers) {
            numbers.forEach((num, i) => {
              if (inputs[index + i]) {
                inputs[index + i].value = num;
                inputs[index + i].classList.add("has-value");
                if (index + i + 1 < inputs.length) {
                  inputs[index + i + 1].focus();
                } else {
                  // If paste fills all inputs, submit the form
                  const pin = Array.from(inputs)
                    .map((input) => input.value)
                    .join("");
                  submitPin(pin, inputs);
                }
              }
            });
          }
        });
      });
    });
}

// Handle PIN submission
function submitPin(pin, inputs) {
  const errorElement = document.querySelector(".pin-error");

  fetch("/verify-pin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ pin }),
  })
    .then(async (response) => {
      const data = await response.json();

      if (response.ok) {
        window.location.pathname = "/";
      } else if (response.status === 429) {
        // Handle lockout
        errorElement.textContent = data.error;
        errorElement.setAttribute("aria-hidden", "false");
        inputs.forEach((input) => {
          input.value = "";
          input.classList.remove("has-value");
          input.disabled = true;
        });
      } else {
        // Handle invalid PIN
        const message =
          data.attemptsLeft > 0
            ? `Incorrect PIN. ${data.attemptsLeft} attempts remaining.`
            : "Incorrect PIN. Last attempt before lockout.";

        errorElement.textContent = message;
        errorElement.setAttribute("aria-hidden", "false");
        inputs.forEach((input) => {
          input.value = "";
          input.classList.remove("has-value");
        });
        inputs[0].focus();
      }
    })
    .catch((error) => {
      console.error("Error:", error);
      errorElement.textContent = "An error occurred. Please try again.";
      errorElement.setAttribute("aria-hidden", "false");
    });
}

// Supported currencies list
const SUPPORTED_CURRENCIES = {
  USD: { locale: "en-US", symbol: "$" },
  EUR: { locale: "de-DE", symbol: "€" },
  GBP: { locale: "en-GB", symbol: "£" },
  JPY: { locale: "ja-JP", symbol: "¥" },
  AUD: { locale: "en-AU", symbol: "A$" },
  CAD: { locale: "en-CA", symbol: "C$" },
  CHF: { locale: "de-CH", symbol: "CHF" },
  CNY: { locale: "zh-CN", symbol: "¥" },
  HKD: { locale: "zh-HK", symbol: "HK$" },
  NZD: { locale: "en-NZ", symbol: "NZ$" },
  NOK: { local: "no-NB", synmbol: "NOK" },
};

let currentCurrency = "USD"; // Default currency

// Fetch current currency from server
async function fetchCurrentCurrency() {
  try {
    const response = await fetch("/api/settings/currency", fetchConfig);
    await handleFetchResponse(response);
    const data = await response.json();
    currentCurrency = data.currency;
  } catch (error) {
    console.error("Error fetching currency:", error);
    // Fallback to USD if there's an error
    currentCurrency = "USD";
  }
}

// Update the formatCurrency function to use the current currency
const formatCurrency = (amount) => {
  const currencyInfo =
    SUPPORTED_CURRENCIES[currentCurrency] || SUPPORTED_CURRENCIES.USD;
  return new Intl.NumberFormat(currencyInfo.locale, {
    style: "currency",
    currency: currentCurrency,
  }).format(amount);
};

let currentDate = new Date();

// Shared fetch configuration
const fetchConfig = {
  credentials: "include",
  headers: {
    "Content-Type": "application/json",
  },
};

// Handle session errors - only for main app, not login
async function handleFetchResponse(response) {
  if (!response.ok) {
    if (
      response.status === 401 &&
      !window.location.pathname.includes("login")
    ) {
      window.location.pathname = "/login";
      return null;
    }
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response;
}

// Add currentFilter variable at the top with other shared variables
let currentFilter = null; // null = show all, 'income' = only income, 'expense' = only expenses

// Add at the top with other variables
let editingTransactionId = null;

// Add at the top with other shared variables
let currentSortField = "date";
let currentSortDirection = "desc";

// Update loadTransactions function
async function loadTransactions() {
  try {
    const startDate = document.getElementById("startDate").value;
    const endDate = document.getElementById("endDate").value;

    const response = await fetch(
      `/api/transactions/range?start=${startDate}&end=${endDate}`,
      fetchConfig
    );
    await handleFetchResponse(response);
    const transactions = await response.json();

    const transactionsList = document.getElementById("transactionsList");
    let filteredTransactions = currentFilter
      ? transactions.filter((t) => t.type === currentFilter)
      : transactions;

    // Sort transactions
    filteredTransactions.sort((a, b) => {
      if (currentSortField === "date") {
        // Use string comparison for dates to avoid timezone issues
        return currentSortDirection === "asc"
          ? a.date.localeCompare(b.date)
          : b.date.localeCompare(a.date);
      } else {
        return currentSortDirection === "asc"
          ? a.amount - b.amount
          : b.amount - a.amount;
      }
    });

    transactionsList.innerHTML = filteredTransactions
      .map((transaction) => {
        // Split the date string and format as M/D/YYYY without timezone conversion
        const [year, month, day] = transaction.date.split("-");
        const formattedDate = `${parseInt(month)}/${parseInt(day)}/${year}`;

        return `
            <div class="transaction-item" data-id="${
              transaction.id
            }" data-type="${transaction.type}">
                <div class="transaction-content">
                    <div class="details">
                        <div class="description">${
                          transaction.description
                        }</div>
                        <div class="metadata">
                            ${
                              transaction.category
                                ? `<span class="category">${transaction.category}</span>`
                                : ""
                            }
                            <span class="date">${formattedDate}</span>
                        </div>
                    </div>
                    <div class="transaction-amount ${transaction.type}">
                        ${
                          transaction.type === "expense" ? "-" : ""
                        }${formatCurrency(transaction.amount)}
                    </div>
                </div>
                <button class="delete-transaction" aria-label="Delete transaction">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 6h18"></path>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path>
                        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                </button>
            </div>
        `;
      })
      .join("");

    // Add click handlers for editing and deleting
    transactionsList.querySelectorAll(".transaction-item").forEach((item) => {
      const deleteBtn = item.querySelector(".delete-transaction");
      const content = item.querySelector(".transaction-content");

      // Edit handler
      content.addEventListener("click", () => {
        const id = item.dataset.id;
        const type = item.dataset.type;
        editTransaction(
          id,
          filteredTransactions.find((t) => t.id === id)
        );
      });

      // Delete handler
      deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (confirm("Are you sure you want to delete this transaction?")) {
          const id = item.dataset.id;
          try {
            const response = await fetch(`/api/transactions/${id}`, {
              ...fetchConfig,
              method: "DELETE",
            });
            await handleFetchResponse(response);
            await loadTransactions();
            await updateTotals();
          } catch (error) {
            console.error("Error deleting transaction:", error);
            alert("Failed to delete transaction. Please try again.");
          }
        }
      });
    });
  } catch (error) {
    console.error("Error loading transactions:", error);
  }
}

// Add editTransaction function
function editTransaction(id, transaction) {
  editingTransactionId = id;
  const modal = document.getElementById("transactionModal");
  const form = document.getElementById("transactionForm");
  const toggleBtns = document.querySelectorAll(".toggle-btn");
  const categoryField = document.getElementById("categoryField");

  // Set form values
  document.getElementById("amount").value = transaction.amount;
  document.getElementById("description").value = transaction.description;
  document.getElementById("transactionDate").value = transaction.date;

  // Set transaction type
  toggleBtns.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.type === transaction.type);
  });

  // Show/hide and set category for expenses
  if (transaction.type === "expense") {
    categoryField.style.display = "block";
    document.getElementById("category").value = transaction.category;
  } else {
    categoryField.style.display = "none";
  }

  // Update form submit button text
  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.textContent = "Update";

  // Show modal
  modal.classList.add("active");
}

async function updateTotals() {
  try {
    const startDate = document.getElementById("startDate").value;
    const endDate = document.getElementById("endDate").value;

    const response = await fetch(
      `/api/totals/range?start=${startDate}&end=${endDate}`,
      fetchConfig
    );
    await handleFetchResponse(response);
    const totals = await response.json();

    document.getElementById("totalIncome").textContent = formatCurrency(
      totals.income
    );
    document.getElementById("totalExpenses").textContent = formatCurrency(
      totals.expenses
    );
    const balanceElement = document.getElementById("totalBalance");
    balanceElement.textContent = formatCurrency(totals.balance);

    // Add appropriate class based on balance value
    balanceElement.classList.remove("positive", "negative");
    if (totals.balance > 0) {
      balanceElement.classList.add("positive");
    } else if (totals.balance < 0) {
      balanceElement.classList.add("negative");
    }
  } catch (error) {
    console.error("Error updating totals:", error);
  }
}

// Initialize modal functionality
function initModalHandling() {
  const modal = document.getElementById("transactionModal");
  // Only initialize if we're on the main page
  if (!modal) return;

  const addTransactionBtn = document.getElementById("addTransactionBtn");
  const closeModalBtn = document.querySelector(".close-modal");
  const transactionForm = document.getElementById("transactionForm");
  const categoryField = document.getElementById("categoryField");
  const toggleBtns = document.querySelectorAll(".toggle-btn");
  const amountInput = document.getElementById("amount");

  let currentTransactionType = "income";

  // Update amount input placeholder with current currency symbol
  function updateAmountPlaceholder() {
    const currencyInfo =
      SUPPORTED_CURRENCIES[currentCurrency] || SUPPORTED_CURRENCIES.USD;
    amountInput.placeholder = `Amount (${currencyInfo.symbol})`;
  }

  // Open modal
  addTransactionBtn.addEventListener("click", () => {
    modal.classList.add("active");
    // Reset form
    transactionForm.reset();
    // Reset toggle buttons
    toggleBtns.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.type === "income");
    });
    // Hide category field for income by default
    categoryField.style.display = "none";
    currentTransactionType = "income";

    // Set today's date as default
    const today = new Date().toISOString().split("T")[0];
    document.getElementById("transactionDate").value = today;

    // Update amount placeholder with current currency
    updateAmountPlaceholder();
  });

  // Close modal
  const closeModal = () => {
    modal.classList.remove("active");
    editingTransactionId = null;
    const submitBtn = transactionForm.querySelector('button[type="submit"]');
    submitBtn.textContent = "Add";
  };

  closeModalBtn.addEventListener("click", closeModal);

  // Close modal when clicking outside
  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      closeModal();
    }
  });

  // Transaction type toggle
  toggleBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      // Remove active class from all buttons
      toggleBtns.forEach((b) => b.classList.remove("active"));
      // Add active class to clicked button
      btn.classList.add("active");

      currentTransactionType = btn.dataset.type;

      // Show/hide category field based on transaction type
      categoryField.style.display =
        currentTransactionType === "expense" ? "block" : "none";
    });
  });

  // Update form submission
  transactionForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const formData = {
      type: currentTransactionType,
      amount: parseFloat(document.getElementById("amount").value),
      description: document.getElementById("description").value,
      category:
        currentTransactionType === "expense"
          ? document.getElementById("category").value
          : null,
      date: document.getElementById("transactionDate").value,
    };

    try {
      const url = editingTransactionId
        ? `/api/transactions/${editingTransactionId}`
        : "/api/transactions";

      const method = editingTransactionId ? "PUT" : "POST";

      const response = await fetch(url, {
        ...fetchConfig,
        method,
        body: JSON.stringify(formData),
      });

      await handleFetchResponse(response);

      // Reset editing state
      editingTransactionId = null;

      // Update submit button text
      const submitBtn = transactionForm.querySelector('button[type="submit"]');
      submitBtn.textContent = "Add";

      // Close modal and reset form
      closeModal();
      transactionForm.reset();

      // Refresh transactions list and totals
      await loadTransactions();
      await updateTotals();
    } catch (error) {
      console.error("Error saving transaction:", error);
      alert("Failed to save transaction. Please try again.");
    }
  });
}

// Update the initMainPage function to fetch currency first
async function initMainPage() {
  await fetchCurrentCurrency();
  const mainContainer = document.getElementById("transactionModal");
  if (!mainContainer) return; // Only run on main page

  // Update amount placeholder when currency changes
  const amountInput = document.getElementById("amount");
  if (amountInput) {
    const currencyInfo =
      SUPPORTED_CURRENCIES[currentCurrency] || SUPPORTED_CURRENCIES.USD;
    amountInput.placeholder = `Amount (${currencyInfo.symbol})`;
  }

  const startDateInput = document.getElementById("startDate");
  const endDateInput = document.getElementById("endDate");

  // Set initial date range to current month
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  startDateInput.value = firstDay.toISOString().split("T")[0];
  endDateInput.value = lastDay.toISOString().split("T")[0];

  // Add event listeners for date changes
  startDateInput.addEventListener("change", () => {
    if (startDateInput.value > endDateInput.value) {
      endDateInput.value = startDateInput.value;
    }
    loadTransactions();
    updateTotals();
  });

  endDateInput.addEventListener("change", () => {
    if (endDateInput.value < startDateInput.value) {
      startDateInput.value = endDateInput.value;
    }
    loadTransactions();
    updateTotals();
  });

  // Export to CSV
  document.getElementById("exportBtn").addEventListener("click", async () => {
    try {
      const startDate = document.getElementById("startDate").value;
      const endDate = document.getElementById("endDate").value;

      const response = await fetch(
        `/api/export/range?start=${startDate}&end=${endDate}`,
        {
          ...fetchConfig,
          method: "GET",
        }
      );

      // Use the same response handler as other requests
      const handledResponse = await handleFetchResponse(response);
      if (!handledResponse) return;

      const blob = await handledResponse.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `transactions-${startDate}-to-${endDate}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error("Error exporting transactions:", error);
      alert("Failed to export transactions. Please try again.");
    }
  });

  // Add filter button handlers
  const filterButtons = document.querySelectorAll(".filter-btn");
  filterButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const filterType = btn.dataset.filter;

      // Remove active class from all buttons
      filterButtons.forEach((b) => b.classList.remove("active"));

      if (currentFilter === filterType) {
        // If clicking the active filter, clear it
        currentFilter = null;
      } else {
        // Set new filter and activate button
        currentFilter = filterType;
        btn.classList.add("active");
      }

      loadTransactions();
    });
  });

  // Initialize sort controls
  const sortButtons = document.querySelectorAll(".sort-btn");
  const sortDirection = document.getElementById("sortDirection");

  sortButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      // Remove active class from all buttons
      sortButtons.forEach((b) => b.classList.remove("active"));
      // Add active class to clicked button
      btn.classList.add("active");

      currentSortField = btn.dataset.sort;
      loadTransactions();
    });
  });

  sortDirection.addEventListener("click", () => {
    currentSortDirection = currentSortDirection === "asc" ? "desc" : "asc";
    sortDirection.classList.toggle(
      "descending",
      currentSortDirection === "desc"
    );
    loadTransactions();
  });

  // Set initial sort direction indicator
  sortDirection.classList.toggle("descending", currentSortDirection === "desc");

  // Initial load
  loadTransactions();
  updateTotals();
}

// Initialize functionality
document.addEventListener("DOMContentLoaded", () => {
  initThemeToggle();
  setupPinInputs();
  initModalHandling();
  initMainPage();
});
